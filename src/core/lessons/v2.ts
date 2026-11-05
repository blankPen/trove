/** v2 质量流水线:摘要/分类 → Gate A → 轨迹 → 提取 → contract/证据/Gate B/质量 → Gate C → 写/审计/决策日志。 */
import type { Event } from '../events/schema.js';
import type { LearnConfig } from '../../config.js';
import { selectSession } from './select.js';
import { compactEvents } from './compaction.js';
import { summarizeSession, classifySession, renderEvents, anyCategory } from './analyze.js';
import { extractTrajectoryFacts, writeTrajectory } from './trajectory.js';
import { extractMemoriesV2, hasSensitiveSecret } from './extract.js';
import type { MemoryCandidateV2 } from './extract.js';
import { inferScope } from './scope.js';
import { lintExperience, decideQuality } from './contract.js';
import { verifyEvidence } from './evidence.js';
import { newMemoryId, qualityTotal } from './memory.js';
import type { QualityScore } from './memory.js';
import { JevDecisionGateway } from './gateway.js';
import type { SessionDigest, GateResult } from './gateway.js';
import { mergeMemoriesV2 } from './merge.js';
import type { MemoryOp } from './merge.js';
import { applyCapacity, DEFAULT_CAPACITY } from './capacity.js';
import { loadExistingForGate } from './existing.js';
import { applyOperations } from './write.js';
import { buildMemoryDiff, writeMemoryDiff } from './audit.js';
import type { MemoryDiff } from './audit.js';
import { appendDecision } from './decisions.js';
import type { DecisionRecord, DecisionReason, DecisionSource } from './decisions.js';
import type { LlmProvider } from './llm.js';
import type { JevProvider } from './jev.js';
import type { StorageAdapter } from './storage.js';
import { readTrust } from './trust.js';
import { writeInboxItem, newInboxId } from './inbox.js';
import type { InboxItem } from './inbox.js';

export interface V2RunDeps {
  llm: LlmProvider;
  jev: JevProvider;
  storage: StorageAdapter;
  learn: LearnConfig;
  loadEvents: (id: string) => Promise<Event[]>;
  now?: () => Date;
  /** 记忆已落盘、审计未写前回调(diff 可用于崩溃恢复 checkpoint);shadow 不调用。 */
  onWritten?: (diff: MemoryDiff) => Promise<void> | void;
  /** 记忆落盘后的向量增量同步;失败静默(向量是可选增强,不阻断学习)。 */
  syncVectors?: () => Promise<void> | void;
}

export interface V2RunResult {
  diff?: MemoryDiff;
  shadow: boolean;
  skipReason?: string;
  /** review 模式本次新写入 inbox 的候选数(待审)。 */
  pending?: number;
}

const ACCEPT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { decision: { type: 'string', enum: ['accept', 'reject'] } },
  required: ['decision'],
};

export async function runLessonPipelineV2(
  sessionId: string,
  deps: V2RunDeps,
  _opts: { force?: boolean } = {},
): Promise<V2RunResult> {
  const now = deps.now ?? (() => new Date());
  const shadow = deps.learn.mode === 'shadow';
  const events = await deps.loadEvents(sessionId);

  // 1. 会话选择(进行中 → skip)
  const sel = selectSession(events, now());
  if (sel.status === 'skipped') return { shadow, skipReason: sel.reason };
  const selected = sel.events;

  const header = events.find((e) => e.kind === 'session');
  const project = header?.cwd ?? sessionId;
  const eventSession = selected[0]?.session ?? sessionId;

  // 决策写入串到单一 promise 链,避免并发 read+write 互相覆盖;返回前 await 收尾。
  let decisionTail: Promise<void> = Promise.resolve();
  const enqueueDecision = (r: DecisionRecord): void => {
    decisionTail = decisionTail.then(() => appendDecision(deps.storage, { ...r, promptVersion: 'exp-v3' }).catch(() => {}));
  };
  const emit = (p: {
    stage: DecisionRecord['stage'];
    decision: string;
    source: DecisionSource;
    gate?: DecisionRecord['gate'];
    reasons?: DecisionRecord['reasons'];
    candidate?: DecisionRecord['candidate'];
  }): void => {
    enqueueDecision({ at: now().toISOString(), session: eventSession, reasons: [], ...p });
  };
  const logGateway = (r: DecisionRecord): Promise<void> => {
    enqueueDecision(r);
    return decisionTail;
  };

  // 2. T0 启发式(不调模型):无内容 / 高置信密钥形态 → skip(压缩前,用原事件)
  if (selected.length === 0) {
    emit({ stage: 'skip', decision: 'no_content', source: 'heuristic' });
    await decisionTail;
    return { shadow, skipReason: 'no_content' };
  }
  if (hasSensitiveSecret(renderEvents(selected).slice(0, 6000))) {
    emit({ stage: 'skip', decision: 'sensitive', source: 'heuristic' });
    await decisionTail;
    return { shadow, skipReason: 'sensitive' };
  }

  // 2.5 Jev 快速压缩:真实长会话在进入 LLM 前压缩;摘要/分类/轨迹/提取/证据/Gate A 全用这一份压缩事件。
  const compacted = await compactEvents(selected, deps.jev);
  if (compacted.length === 0) {
    emit({ stage: 'skip', decision: 'no_content', source: 'heuristic' });
    await decisionTail;
    return { shadow, skipReason: 'no_content' };
  }

  // 3. 摘要/分类(沿用 v1)
  const summary = await summarizeSession(compacted, deps.llm);
  if (summary.outcome === 'trivial') {
    emit({ stage: 'skip', decision: 'trivial', source: 'llm' });
    await decisionTail;
    return { shadow, skipReason: 'trivial' };
  }
  const classification = await classifySession(summary, deps.llm);
  if (!anyCategory(classification)) {
    emit({ stage: 'skip', decision: 'no_category', source: 'llm' });
    await decisionTail;
    return { shadow, skipReason: 'no_category' };
  }

  // 4. Gate A
  const gateway = new JevDecisionGateway({ jev: deps.jev, learn: deps.learn, log: logGateway, now, session: eventSession });
  const digest: SessionDigest = {
    session: eventSession,
    summary,
    eventCount: compacted.length,
    toolCallCount: compacted.filter((e) => e.kind === 'tool_call').length,
    hasError: summary.hasError,
    hasCorrection: summary.hasCorrection,
    excerpt: renderEvents(compacted).slice(0, 6000),
  };
  const gateA = await gateway.triageSession(digest);
  if (gateA.decision === 'reject') {
    await decisionTail;
    return { shadow, skipReason: 'triage_rejected' };
  }
  if (gateA.decision === 'escalate') {
    const accept = await llmTriageAdjudicate(digest, deps.llm);
    emit({ stage: 'adjudicate', gate: 'A', decision: accept ? 'accept' : 'reject', source: 'llm' });
    if (!accept) {
      await decisionTail;
      return { shadow, skipReason: 'triage_rejected' };
    }
  }

  // 5. 轨迹:auto 落盘(轨迹是记忆,shadow 不写)
  const facts = await extractTrajectoryFacts(summary, compacted, { llm: deps.llm });
  const trajId = newMemoryId('traj_');
  if (!shadow) {
    await writeTrajectory(deps.storage, { id: trajId, session: eventSession, project, summary, facts, events: compacted, createdAt: now().toISOString() });
  }

  // 6. 提取(与证据校验共用同一份 compacted 事件)
  const candidates = await extractMemoriesV2(summary, classification, compacted, { llm: deps.llm });
  for (const c of candidates) c.scope = inferScope(c.type, project);

  // 7. 逐候选:contract → 证据 → Gate B → 质量/LLM 裁决
  const gateBResults = await gateway.screenCandidates(candidates.map((c) => ({ type: c.type, title: c.title, content: c.content, evidence: c.evidence })));
  const accepted: MemoryCandidateV2[] = [];
  // review 模式 L0/L1 的经验候选先进 inbox,由人 accept 后再走 Gate C(信任升级只在人工 review 后触发)。
  const inboxCandidates: Array<{ c: MemoryCandidateV2; source: DecisionSource; q?: QualityScore }> = [];
  const trust = await readTrust(deps.storage, now);
  const route = (c: MemoryCandidateV2, source: DecisionSource, q?: QualityScore): void => {
    if (deps.learn.mode === 'review' && c.type.startsWith('experiences/') && trust.level < 2) {
      inboxCandidates.push({ c, source, q });
    } else {
      accepted.push(c);
    }
  };
  let evidencePassed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const gateB = gateBResults[i]!;
    try {
      const findings = lintExperience({ type: c.type, content: c.content, evidence: c.evidence });
      if (findings.length > 0) {
        emit({ stage: 'quality', decision: 'lint_rejected', source: 'heuristic', candidate: { type: c.type, title: c.title } });
        continue;
      }
      const check = verifyEvidence(eventSession, c.evidence, compacted);
      if (!check.ok) {
        emit({ stage: 'quality', decision: 'evidence_missing', source: 'heuristic', candidate: { type: c.type, title: c.title } });
        continue;
      }
      evidencePassed++;
      c.evidence = check.refs; // 回填 path/line 溯源
      if (gateB.decision === 'reject') continue; // 已在 gateway 记 log

      // Jev 降级:无分维度证据,直接交 LLM 质量裁决,避免静默接受/拒绝。
      if (gateB.source === 'heuristic') {
        const ok = await llmQualityAdjudicate(c, deps.llm);
        emit({ stage: 'adjudicate', decision: ok ? 'accept' : 'reject', source: 'llm', candidate: { type: c.type, title: c.title } });
        if (ok) { c.confidence = gateB.confidence; c.sourceTrajectories = [trajId]; route(c, 'llm'); }
        continue;
      }

      const q = scoreQuality(gateB);
      const dq = decideQuality(qualityTotal(q), q, deps.learn.quality);
      if (dq.decision === 'reject') {
        emit({ stage: 'quality', decision: dq.reason, source: 'heuristic', candidate: { type: c.type, title: c.title } });
        continue;
      }
      if (dq.decision === 'accept') {
        c.quality = q;
        c.confidence = gateB.confidence;
        c.sourceTrajectories = [trajId];
        emit({ stage: 'quality', decision: 'quality_auto', source: 'heuristic', reasons: qualityReasons(q), candidate: { type: c.type, title: c.title } });
        route(c, 'heuristic', q);
        continue;
      }
      // escalate → LLM 质量裁决
      const ok = await llmQualityAdjudicate(c, deps.llm);
      emit({ stage: 'adjudicate', decision: ok ? 'accept' : 'reject', source: 'llm', candidate: { type: c.type, title: c.title } });
      if (ok) {
        c.quality = q;
        c.confidence = gateB.confidence;
        c.sourceTrajectories = [trajId];
        route(c, 'llm', q);
      }
    } catch (e) {
      emit({ stage: 'quality', decision: `candidate_error:${(e as Error).message}`, source: 'heuristic', candidate: { type: c.type, title: c.title } });
    }
  }

  // 8. 写 inbox(人类 review 队列)→ Gate C 合并 → ops
  for (const ic of inboxCandidates) {
    const item: InboxItem = {
      id: newInboxId(now()),
      session: eventSession,
      type: ic.c.type,
      title: ic.c.title,
      content: ic.c.content,
      evidence: ic.c.evidence,
      ...(ic.c.scope ? { scope: ic.c.scope } : {}),
      ...(ic.q ? { quality: ic.q } : {}),
      ...(ic.c.confidence !== undefined ? { confidence: ic.c.confidence } : {}),
      trajectoryId: trajId,
      promptVersion: 'exp-v3',
      createdAt: now().toISOString(),
    };
    await writeInboxItem(deps.storage, item);
    emit({ stage: 'review', decision: 'inbox', source: ic.source, reasons: ic.q ? qualityReasons(ic.q) : [], candidate: { type: ic.c.type, title: ic.c.title } });
  }

  const existing = await loadExistingForGate(deps.storage);
  const ops = await mergeMemoriesV2(accepted, existing, { gateway, llm: deps.llm, learn: deps.learn });
  const capacityResult = applyCapacity(ops, existing, deps.learn.capacity ?? DEFAULT_CAPACITY);
  for (const { op } of capacityResult.rejected) {
    emit({ stage: 'quality', decision: 'capacity_exceeded', source: 'heuristic', candidate: { type: op.type, title: op.title } });
  }
  const inboxOps: MemoryOp[] = inboxCandidates.map(({ c }) => ({ op: 'skip', type: c.type, title: c.title, reason: 'inbox' }));
  const allOps = [...capacityResult.ops, ...inboxOps];

  const evidenceCoverage = candidates.length ? evidencePassed / candidates.length : 1;
  const v2 = { shadow, candidates: candidates.map((c) => ({ type: c.type, title: c.title })), evidenceCoverage };

  if (shadow) {
    const skipOps: MemoryOp[] = allOps.map((op) => ({ op: 'skip', type: op.type, title: op.op === 'append' ? op.path : op.title, reason: `shadow:${op.op}` }));
    const diff = { ...buildMemoryDiff(skipOps, { sessionId, project }), v2 };
    // 只落 .shadow.json:不占「已学习」标记,切 auto 后同一会话仍可真正补学。
    await deps.storage.write(`audit/${sessionId}.shadow.json`, JSON.stringify(diff, null, 2));
    await decisionTail;
    return { diff, shadow: true };
  }

  await applyOperations(allOps, { storage: deps.storage, now: deps.now, source: sessionId });
  const diff = { ...buildMemoryDiff(allOps, { sessionId, project }), v2 };
  await deps.onWritten?.(diff);
  void Promise.resolve(deps.syncVectors?.()).catch(() => {});
  await writeMemoryDiff(diff, deps.storage);
  await decisionTail;
  return { diff, shadow: false, pending: inboxCandidates.length };
}

function qualityReasons(q: QualityScore): DecisionReason[] {
  return [
    { question: 'specific', probability: q.specific },
    { question: 'actionable', probability: q.actionable },
    { question: 'transferable', probability: q.transferable },
    { question: 'evidence', probability: q.evidence },
    { question: 'non_duplicate', probability: q.non_duplicate },
  ];
}

function scoreQuality(gateB: GateResult): QualityScore {
  const p: Record<string, number> = {};
  for (const r of gateB.reasons) p[r.question] = r.probability;
  return {
    specific: p.specific ?? 0,
    actionable: p.actionable ?? 0,
    transferable: p.transferable ?? 0,
    evidence: 1, // 走到这里证据校验已通过
    non_duplicate: p.non_duplicate ?? 0,
  };
}

async function llmTriageAdjudicate(digest: SessionDigest, llm: LlmProvider): Promise<boolean> {
  try {
    const raw = await llm.generate<{ decision?: unknown }>(
      `判断这个会话是否值得沉淀经验,返回 accept 或 reject。\n摘要:${JSON.stringify(digest.summary)}\n转录片段:${digest.excerpt}`,
      ACCEPT_SCHEMA,
      'learn:triage',
    );
    return raw?.decision === 'accept';
  } catch {
    return false; // 失败按 reject
  }
}

async function llmQualityAdjudicate(c: MemoryCandidateV2, llm: LlmProvider): Promise<boolean> {
  try {
    const raw = await llm.generate<{ decision?: unknown }>(
      `判断这条候选记忆质量是否可接受,返回 accept 或 reject。\n标题:${c.title}\n正文:${c.content}`,
      ACCEPT_SCHEMA,
      'learn:quality',
    );
    return raw?.decision === 'accept';
  } catch {
    return false;
  }
}

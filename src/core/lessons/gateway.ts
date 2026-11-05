/** 决策网关:Gate A/B/C 用 Jev 批量打分,边界带交调用方 LLM 裁决;Jev 不可用时降级启发式,绝不静默接受。 */
import type { LearnConfig } from '../../config.js';
import type { SessionSummary } from './analyze.js';
import type { DecisionReason, DecisionRecord, DecisionSource } from './decisions.js';
import type { JevProvider } from './jev.js';
import type { LlmProvider } from './llm.js';
import type { EvidenceRef, QualityScore } from './memory.js';

export interface GateResult {
  decision: 'accept' | 'reject' | 'escalate';
  confidence: number;
  reasons: DecisionReason[];
  source: DecisionSource;
}

export interface IdentityResult {
  decision: 'add' | 'merge' | 'supersede' | 'escalate';
  confidence: number;
  reasons: DecisionReason[];
  source: DecisionSource;
  targetPath?: string;
  targetId?: string;
}

export interface SessionDigest {
  session: string;
  summary: SessionSummary;
  eventCount: number;
  toolCallCount: number;
  hasError: boolean;
  hasCorrection: boolean;
  /** 有界转录(≤6000 字符),供 Jev 输入。 */
  excerpt: string;
}

export interface CandidateForGate {
  type: string;
  title: string;
  content: string;
  evidence: EvidenceRef[];
}

export interface ExistingForGate {
  id?: string;
  path: string;
  title: string;
  content: string;
  type: string;
  scope?: string;
  /** 容量淘汰建议用;parseMemory 读回,旧文件缺省。 */
  quality?: QualityScore;
  useCount?: number;
}

export interface DecisionGateway {
  triageSession(d: SessionDigest): Promise<GateResult>;
  screenCandidates(c: CandidateForGate[]): Promise<GateResult[]>;
  resolveIdentity(c: CandidateForGate, existing: ExistingForGate[]): Promise<IdentityResult>;
}

/** 纯确定性启发式:测试与 Jev 降级共用。 */
export class HeuristicGateway implements DecisionGateway {
  async triageSession(d: SessionDigest): Promise<GateResult> {
    const hasTrace = d.eventCount > 0 && (d.toolCallCount > 0 || d.hasError || d.hasCorrection);
    if (!hasTrace) {
      return { decision: 'reject', confidence: 0, reasons: [{ question: 'has_trace', probability: 0 }], source: 'heuristic' };
    }
    return { decision: 'accept', confidence: 1, reasons: [{ question: 'has_trace', probability: 1 }], source: 'heuristic' };
  }

  async screenCandidates(c: CandidateForGate[]): Promise<GateResult[]> {
    return c.map((x) =>
      x.evidence.length === 0
        ? { decision: 'reject' as const, confidence: 0, reasons: [{ question: 'evidence', probability: 0 }], source: 'heuristic' as const }
        : { decision: 'escalate' as const, confidence: 1, reasons: [{ question: 'evidence', probability: 1 }], source: 'heuristic' as const },
    );
  }

  async resolveIdentity(): Promise<IdentityResult> {
    return { decision: 'add', confidence: 1, reasons: [], source: 'heuristic' };
  }
}

const HEURISTIC = new HeuristicGateway();

interface GateQuestion {
  instructions: string;
  threshold: number;
}

const GATE_A: Record<string, GateQuestion> = {
  has_task: { threshold: 0.55, instructions: '这个会话是否有明确的任务或目标?' },
  has_trace: { threshold: 0.55, instructions: '这个会话是否留下可回溯的执行痕迹(命令/错误/路径)?' },
  has_lesson: { threshold: 0.55, instructions: '这个会话是否蕴含可复用的经验?' },
  safe: { threshold: 0.8, instructions: '这个会话内容是否安全可沉淀(不含敏感信息或高风险操作)?' },
};
const GATE_A_REJECT = 0.35;

const GATE_B: Record<string, GateQuestion> = {
  specific: { threshold: 0.6, instructions: '这条记忆是否具体(含命令/错误串/路径等字面量)?' },
  actionable: { threshold: 0.6, instructions: '这条记忆是否可操作、可执行?' },
  transferable: { threshold: 0.6, instructions: '这条记忆是否可跨场景迁移复用?' },
  non_duplicate: { threshold: 0.6, instructions: '这条记忆是否与现有记忆不重复?' },
  safe: { threshold: 0.8, instructions: '这条记忆是否安全可沉淀?' },
};
const GATE_B_REJECT = 0.4;

const GATE_C = {
  same_intent: '候选记忆与这条旧记忆是否表达同一意图/目标?',
  same_boundary: '候选记忆与这条旧记忆是否适用同一场景边界?',
  supersedes: '候选记忆是否应取代(纠正/推翻)这条旧记忆?',
};
const MERGE_MIN = 0.8;
const SUPERSEDE_MIN = 0.75;
const RELATED_LOW = 0.5;

export interface JevGatewayOptions {
  jev: JevProvider | null;
  learn: LearnConfig;
  /** 边界带裁决由调用方 LLM 完成,本类保持无状态不自己调 LLM。 */
  llm?: LlmProvider | null;
  log?: (r: DecisionRecord) => Promise<void>;
  now?: () => Date;
  session?: string;
}

export class JevDecisionGateway implements DecisionGateway {
  private jev: JevProvider | null;
  private learn: LearnConfig;
  private log?: (r: DecisionRecord) => Promise<void>;
  private now: () => Date;
  private session: string;
  private calls = 0;

  constructor(opts: JevGatewayOptions) {
    this.jev = opts.jev;
    this.learn = opts.learn;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.session = opts.session ?? '';
  }

  async triageSession(d: SessionDigest): Promise<GateResult> {
    const scores = await this.keep({ summary: d.summary, excerpt: d.excerpt }, GATE_A);
    let result: GateResult;
    if (scores) {
      result = { ...decide(scores, GATE_A, GATE_A_REJECT), source: 'jev' };
    } else {
      result = await HEURISTIC.triageSession(d);
    }
    await this.emit({ stage: 'triage', gate: 'A', decision: result.decision, source: result.source, reasons: result.reasons });
    return result;
  }

  async screenCandidates(c: CandidateForGate[]): Promise<GateResult[]> {
    const withEvidence = c.map((x, i) => ({ x, i })).filter(({ x }) => x.evidence.length > 0);
    const questions: Record<string, { instructions: string }> = {};
    for (const { i } of withEvidence) {
      for (const [name, q] of Object.entries(GATE_B)) questions[`${i}:${name}`] = { instructions: q.instructions };
    }
    let scores: Record<string, number> | null = null;
    if (withEvidence.length > 0) scores = await this.keep({ candidates: c }, questions);

    const results: GateResult[] = [];
    for (let i = 0; i < c.length; i++) {
      const x = c[i]!;
      let result: GateResult;
      if (x.evidence.length === 0) {
        result = { decision: 'reject', confidence: 0, reasons: [{ question: 'evidence', probability: 0 }], source: 'heuristic' };
      } else if (!scores) {
        result = { decision: 'escalate', confidence: 1, reasons: [{ question: 'evidence', probability: 1 }], source: 'heuristic' };
      } else {
        const own: Record<string, number> = {};
        for (const name of Object.keys(GATE_B)) own[name] = scores[`${i}:${name}`] ?? 0;
        result = { ...decide(own, GATE_B, GATE_B_REJECT), source: 'jev' };
      }
      results.push(result);
      await this.emit({ stage: 'screen', gate: 'B', decision: result.decision, source: result.source, reasons: result.reasons, candidate: { type: x.type, title: x.title } });
    }
    return results;
  }

  async resolveIdentity(c: CandidateForGate, existing: ExistingForGate[]): Promise<IdentityResult> {
    const top = existing.filter((e) => e.type === c.type).slice(0, 5);
    if (top.length === 0) {
      const r: IdentityResult = { decision: 'add', confidence: 1, reasons: [], source: 'heuristic' };
      await this.emit({ stage: 'identity', gate: 'C', decision: r.decision, source: r.source, reasons: r.reasons, candidate: { type: c.type, title: c.title } });
      return r;
    }
    const questions: Record<string, { instructions: string }> = {};
    top.forEach((_e, j) => {
      for (const [name, instr] of Object.entries(GATE_C)) questions[`${j}:${name}`] = { instructions: instr };
    });
    const scores = await this.keep({ candidate: c, existing: top }, questions);
    if (!scores) {
      const r: IdentityResult = { decision: 'add', confidence: 1, reasons: [], source: 'heuristic' };
      await this.emit({ stage: 'identity', gate: 'C', decision: r.decision, source: r.source, reasons: r.reasons, candidate: { type: c.type, title: c.title } });
      return r;
    }

    const reasons: DecisionReason[] = Object.entries(scores).map(([question, probability]) => ({ question, probability }));
    const confidence = reasons.length ? Math.min(...reasons.map((r) => r.probability)) : 0;

    let mergeTarget: ExistingForGate | undefined;
    let mergeScore = -1;
    let supersedeTarget: ExistingForGate | undefined;
    let supersedeScore = -1;
    top.forEach((e, j) => {
      const sameIntent = scores[`${j}:same_intent`] ?? 0;
      const sameBoundary = scores[`${j}:same_boundary`] ?? 0;
      const supersedes = scores[`${j}:supersedes`] ?? 0;
      if (sameIntent >= MERGE_MIN && sameBoundary >= MERGE_MIN && sameIntent + sameBoundary > mergeScore) {
        mergeTarget = e;
        mergeScore = sameIntent + sameBoundary;
      }
      if (supersedes >= SUPERSEDE_MIN && supersedes > supersedeScore) {
        supersedeTarget = e;
        supersedeScore = supersedes;
      }
    });

    let result: IdentityResult;
    if (mergeTarget) {
      result = { decision: 'merge', confidence, reasons, source: 'jev', targetPath: mergeTarget.path, targetId: mergeTarget.id };
    } else if (supersedeTarget) {
      result = { decision: 'supersede', confidence, reasons, source: 'jev', targetPath: supersedeTarget.path, targetId: supersedeTarget.id };
    } else if (Object.values(scores).some((p) => p >= RELATED_LOW && p < MERGE_MIN)) {
      result = { decision: 'escalate', confidence, reasons, source: 'jev' };
    } else {
      result = { decision: 'add', confidence, reasons, source: 'jev' };
    }
    await this.emit({
      stage: 'identity',
      gate: 'C',
      decision: result.decision,
      source: result.source,
      reasons: result.reasons,
      candidate: { type: c.type, title: c.title },
      target: result.targetPath ?? result.targetId,
    });
    return result;
  }

  /** 一次批量 keepCalls;未配置/超预算/抛错/超时返回 null,由调用方降级。 */
  private async keep(state: unknown, questions: Record<string, { instructions: string }>): Promise<Record<string, number> | null> {
    if (!this.jev?.keepCalls) return null;
    if (this.calls >= this.learn.jev.maxCallsPerSession) return null;
    this.calls++;
    try {
      return await Promise.race([this.jev.keepCalls(state, questions), timeout(this.learn.jev.timeoutMs)]);
    } catch {
      return null;
    }
  }

  private async emit(o: {
    stage: DecisionRecord['stage'];
    gate: DecisionRecord['gate'];
    decision: string;
    source: DecisionSource;
    reasons: DecisionReason[];
    candidate?: { type: string; title: string };
    target?: string;
  }): Promise<void> {
    if (!this.log) return;
    const record: DecisionRecord = {
      at: this.now().toISOString(),
      session: this.session,
      stage: o.stage,
      gate: o.gate,
      decision: o.decision,
      source: o.source,
      reasons: o.reasons,
      ...(o.candidate ? { candidate: o.candidate } : {}),
      ...(o.target ? { target: o.target } : {}),
    };
    try {
      await this.log(record);
    } catch {
      // 决策日志失败不阻断流水线
    }
  }
}

/** 按每问阈值判定:任一 <rejectFloor → reject;任一落在 [rejectFloor, threshold) → escalate;全部达标 → accept。 */
function decide(
  scores: Record<string, number>,
  questions: Record<string, GateQuestion>,
  rejectFloor: number,
): { decision: 'accept' | 'reject' | 'escalate'; confidence: number; reasons: DecisionReason[] } {
  const entries = Object.entries(scores);
  const reasons = entries.map(([question, probability]) => ({ question, probability }));
  const probs = entries.map(([, p]) => p);
  const confidence = probs.length ? Math.min(...probs) : 0;
  if (entries.some(([name, p]) => p < rejectFloor)) return { decision: 'reject', confidence, reasons };
  if (entries.some(([name, p]) => p < (questions[name]?.threshold ?? 0.6))) return { decision: 'escalate', confidence, reasons };
  return { decision: 'accept', confidence, reasons };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const signal = AbortSignal.timeout(ms);
    signal.addEventListener('abort', () => reject(new Error(`Jev 判定超时:${ms}ms`)), { once: true });
  });
}

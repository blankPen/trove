/** 单会话学习流水线:读取 → 压缩(JEV) → 检索相关记忆 → 一次结构化分析(LLM) → 校验 → 增量写入。 */
import type { Event } from '../events/schema.js';
import type { LearnConfig } from '../../config.js';
import type { LlmProvider } from './llm.js';
import type { JevProvider } from './jev.js';
import type { StorageAdapter } from './storage.js';
import type { MemoryDiff } from './audit.js';
import type { MemoryOp } from './merge.js';
import { selectSession } from './select.js';
import { compactEvents } from './compaction.js';
import { hasSensitiveSecret } from './secrets.js';
import { loadExistingForGate, selectRelatedMemories } from './existing.js';
import { analyzeOps } from './ops.js';
import { applyCapacity, DEFAULT_CAPACITY } from './capacity.js';
import { applyOperations } from './write.js';
import { buildMemoryDiff, writeMemoryDiff } from './audit.js';

export interface PipelineDeps {
  llm: LlmProvider;
  /** Jev 用于压缩;null 时退化为确定性截断。 */
  jev: JevProvider | null;
  storage: StorageAdapter;
  learn: LearnConfig;
  loadEvents: (id: string) => Promise<Event[]>;
  now?: () => Date;
  /** 记忆落盘、审计未写前回调(diff 可用于崩溃恢复 checkpoint)。 */
  onWritten?: (diff: MemoryDiff) => Promise<void> | void;
  /** 记忆落盘后的检索索引增量同步;失败静默。 */
  syncIndex?: () => Promise<void> | void;
  /** 阶段进度(手动 learn 用);daemon 不注入避免刷日志。 */
  onStage?: (line: string) => void;
}

export interface PipelineResult {
  diff?: MemoryDiff;
  shadow: boolean;
  skipReason?: string;
}

export async function runLessonPipeline(
  sessionId: string,
  deps: PipelineDeps,
  _opts: { force?: boolean } = {},
): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  // 审核链路已下线:review 模式退化为 shadow(只写审计,不写记忆)。
  const shadow = deps.learn.mode === 'shadow' || deps.learn.mode === 'review';
  let stageAt = Date.now();
  const stage = (label: string, source: string): void => {
    const at = Date.now();
    deps.onStage?.(`  ${label} · ${source} · ${((at - stageAt) / 1000).toFixed(1)}s`);
    stageAt = at;
  };

  let events: Event[];
  try {
    events = await deps.loadEvents(sessionId);
  } catch (e) {
    // collect 会把非会话文件(技能脚本、history.jsonl)当会话入队;一次跳过,不重试。
    if ((e as Error).message.includes('没有找到会话')) return { shadow, skipReason: 'session_not_found' };
    throw e;
  }
  stage('读取会话', '本地');

  const sel = selectSession(events, now());
  if (sel.status === 'skipped') return { shadow, skipReason: sel.reason };
  const selected = sel.events;
  if (selected.length === 0) return { shadow, skipReason: 'no_content' };

  // T0:高置信凭据直接跳过,不调任何模型。
  if (hasSensitiveSecret(renderText(selected).slice(0, 6000))) return { shadow, skipReason: 'sensitive' };

  const header = events.find((e) => e.kind === 'session');
  const project = header?.cwd ?? sessionId;
  const eventSession = selected[0]?.session ?? sessionId;

  const compacted = await compactEvents(selected, deps.jev);
  stage(`压缩 ${selected.length}→${compacted.length} 条事件`, 'JEV');
  if (compacted.length === 0) return { shadow, skipReason: 'no_content' };

  const existing = await loadExistingForGate(deps.storage);
  const related = selectRelatedMemories(compacted, existing, project);
  stage(`相关记忆 ${related.length}/${existing.length} 条`, '本地');

  const { ops, rejected } = await analyzeOps(
    { session: eventSession, project, events: compacted, existing, related },
    deps.llm,
  );
  stage(`分析 ${ops.length} 条 ops`, 'LLM');

  if (ops.length === 0 && rejected.length === 0) return { shadow, skipReason: 'no_ops' };

  const capacity = applyCapacity(ops, existing, deps.learn.capacity ?? DEFAULT_CAPACITY);
  const allOps: MemoryOp[] = [
    ...capacity.ops,
    ...capacity.rejected.map((r) => ({ op: 'skip' as const, type: r.op.type, title: r.op.title, reason: `capacity:${r.decision}` })),
    ...rejected.map((r) => ({ op: 'skip' as const, type: r.type, title: r.title, reason: `rejected:${r.reason}` })),
  ];

  if (shadow) {
    const diff = buildMemoryDiff(allOps, { sessionId, project });
    await deps.storage.write(`audit/${sessionId}.shadow.json`, JSON.stringify(diff, null, 2));
    return { diff, shadow: true };
  }

  await applyOperations(capacity.ops, { storage: deps.storage, now: deps.now, source: sessionId });
  stage('写盘', '本地');

  const diff = buildMemoryDiff(allOps, { sessionId, project });
  await deps.onWritten?.(diff);
  void Promise.resolve(deps.syncIndex?.()).catch(() => {});
  await writeMemoryDiff(diff, deps.storage);
  return { diff, shadow: false };
}

/** 只取事件文本做 T0 扫描,避免把结构字段一起渲染。 */
function renderText(events: Event[]): string {
  return events
    .map((e) => e.text ?? (typeof e.result?.output === 'string' ? e.result.output : ''))
    .filter(Boolean)
    .join('\n');
}

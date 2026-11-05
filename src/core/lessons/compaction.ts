/** LLM 分析前的 Jev 快速压缩:只保留关键 tool 调用对,user/assistant 文字永不删。参照 fast-jev-compaction。 */
import type { Event } from '../events/schema.js';
import type { JevProvider, JevKeepQuestion } from './jev.js';
import { renderEvents } from './analyze.js';
import { truncateEvent, truncateEvents } from './select.js';

const KEEP_THRESHOLD = 0.5;
/** 调用对少于此数不值得调 Jev,直接走确定性兜底。 */
const MIN_CALLS_TO_COMPACT = 15;
/** 压缩后渲染文本的字符预算 ≈ 30k token(按 4 字符/token 粗估)。 */
const MAX_RENDER_CHARS = 30_000 * 4;

/** 对已过滤的 events 做 Jev 快速压缩;jev 未配置/不支持/判定失败时降级为确定性截断。 */
export async function compactEvents(events: Event[], jev: JevProvider | null): Promise<Event[]> {
  const calls = collectCalls(events);
  if (!jev || calls.length <= MIN_CALLS_TO_COMPACT || !jev.keepCalls) return truncateFallback(events);

  const questions: Record<string, JevKeepQuestion> = {};
  for (const c of calls) {
    questions[c.id] = { instructions: '该工具调用及其结果,是否为沉淀本会话可复用经验所必需的关键信息?' };
  }

  let keep: Record<string, number>;
  try {
    keep = await jev.keepCalls(renderEvents(events), questions);
  } catch {
    // 压缩 best-effort:判定失败退回确定性截断,不让一次 noul 请求拖垮整条提取。
    return truncateFallback(events);
  }

  const drop = new Set<number>();
  for (const c of calls) {
    if ((keep[c.id] ?? KEEP_THRESHOLD) < KEEP_THRESHOLD) {
      drop.add(c.callSeq);
      if (c.resultSeq !== undefined) drop.add(c.resultSeq);
    }
  }
  const kept = events.filter((e) => !drop.has(e.seq)).map(truncateEvent);
  // 压缩后仍超预算则整体退回确定性截断,保证 LLM 输入有界。
  return renderEvents(kept).length > MAX_RENDER_CHARS ? truncateFallback(events) : kept;
}

/** 确定性兜底:首尾各 40 条 + 单字段 1200 字符截断。 */
function truncateFallback(events: Event[]): Event[] {
  return truncateEvents(events).map(truncateEvent);
}

interface CallPair {
  id: string;
  callSeq: number;
  resultSeq?: number;
}

/** 提取 tool_call,按 call_id 关联其 tool_result;无 call_id 的 call 用 seq 作键。孤儿 result 不在返回中,天然保留。 */
function collectCalls(events: Event[]): CallPair[] {
  const resultSeqByCall = new Map<string, number>();
  for (const e of events) {
    const callId = e.kind === 'tool_result' ? e.result?.call_id : undefined;
    if (callId) resultSeqByCall.set(callId, e.seq);
  }
  const calls: CallPair[] = [];
  for (const e of events) {
    if (e.kind !== 'tool_call') continue;
    const callId = e.tool?.call_id;
    calls.push({ id: callId ?? String(e.seq), callSeq: e.seq, resultSeq: callId ? resultSeqByCall.get(callId) : undefined });
  }
  return calls;
}

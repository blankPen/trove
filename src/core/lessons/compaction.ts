/** LLM 分析前的 Jev 快速压缩:只保留关键 tool 调用对,user/assistant 文字永不删。参照 fast-jev-compaction。 */
import type { Event } from '../events/schema.js';
import type { JevProvider, JevKeepQuestion } from './jev.js';
import { renderEvents } from './analyze.js';
import { truncateEvent, truncateEvents } from './select.js';

const KEEP_THRESHOLD = 0.5;
/** 噪音分达到该值即丢弃:与 keep 同阈值,两边都过才保留。 */
const NOISE_THRESHOLD = 0.5;
/** 调用对少于此数不值得调 Jev,直接走确定性兜底。 */
const MIN_CALLS_TO_COMPACT = 15;
/** 压缩后渲染文本的字符预算 ≈ 30k token(按 4 字符/token 粗估)。 */
const MAX_RENDER_CHARS = 30_000 * 4;
/** 不含关键信号时,超大工具输出先截到这个长度。 */
const MAX_CLEAN_RESULT_CHARS = 8000;
const TRUNCATED_RESULT_CHARS = 1200;
/** 含这些信号的大输出不截断:错误串/配置/测试结论本身就是经验素材。 */
const SIGNAL_TEXT = /error|failed|exception|traceback|panic|fatal|assert|EACCES|ENOENT|ETIMEDOUT|ECONN/i;

/** 对已过滤的 events 做 Jev 快速压缩;jev 未配置/不支持/判定失败时降级为确定性截断。 */
export async function compactEvents(events: Event[], jev: JevProvider | null): Promise<Event[]> {
  // 确定性预过滤先行:噪音与超大输出不该占用 Jev 的判定预算。
  const cleaned = dropRepeatedRetries(capBigResults(dropNoise(events)));
  const calls = collectCalls(cleaned);
  if (!jev || calls.length <= MIN_CALLS_TO_COMPACT || !jev.keepCalls) return truncateFallback(cleaned);

  const questions: Record<string, JevKeepQuestion> = {};
  for (const c of calls) {
    questions[`${c.id}:reusable`] = { instructions: '该工具调用及其结果是否包含可跨会话复用的信息(命令、错误串、配置、路径、结论)?' };
    questions[`${c.id}:noise`] = { instructions: '该工具调用及其结果是否只是重复尝试、大段无关内容或与任务无关的输出?' };
  }

  let scores: Record<string, number>;
  try {
    scores = await jev.keepCalls(renderEvents(cleaned), questions);
  } catch {
    // 压缩 best-effort:判定失败退回确定性截断,不让一次 noul 请求拖垮整条提取。
    return truncateFallback(cleaned);
  }

  const drop = new Set<number>();
  for (const c of calls) {
    const reusable = scores[`${c.id}:reusable`] ?? KEEP_THRESHOLD;
    const noise = scores[`${c.id}:noise`] ?? 0;
    if (reusable < KEEP_THRESHOLD || noise >= NOISE_THRESHOLD) {
      drop.add(c.callSeq);
      if (c.resultSeq !== undefined) drop.add(c.resultSeq);
    }
  }
  const kept = cleaned.filter((e) => !drop.has(e.seq)).map(truncateEvent);
  // 压缩后仍超预算则整体退回确定性截断,保证 LLM 输入有界。
  return renderEvents(kept).length > MAX_RENDER_CHARS ? truncateFallback(cleaned) : kept;
}

/** 空输出与纯进度/纯数字行对经验沉淀无价值,直接丢弃结果(调用本身保留)。 */
function dropNoise(events: Event[]): Event[] {
  return events.filter((e) => {
    if (e.kind !== 'tool_result') return true;
    const text = typeof e.result?.output === 'string' ? e.result.output : '';
    const t = text.trim();
    if (!t) return false;
    if (/^\[progress\]/i.test(t)) return false;
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    return !(lines.length > 0 && lines.every((l) => /^[\d\s.,:/%-]+$/.test(l)));
  });
}

/** 无错误信号的大段输出截断,保留开头与总长度提示。 */
function capBigResults(events: Event[]): Event[] {
  return events.map((e) => {
    if (e.kind !== 'tool_result') return e;
    const text = typeof e.result?.output === 'string' ? e.result.output : '';
    if (text.length <= MAX_CLEAN_RESULT_CHARS || SIGNAL_TEXT.test(text)) return e;
    return { ...e, result: { ...e.result, output: `${text.slice(0, TRUNCATED_RESULT_CHARS)}…[已截断 ${text.length} 字符]` } };
  });
}

/** 同一 tool_call(名+入参)失败后重试:只保留最后一次尝试。
 *  只有前一次失败、且两次之间没有 assistant 回复时才算重试——成功后的重复调用是独立动作。 */
function dropRepeatedRetries(events: Event[]): Event[] {
  const resultInfo = new Map<string, { seq: number; failed: boolean }>();
  for (const e of events) {
    const id = e.kind === 'tool_result' ? e.result?.call_id : undefined;
    if (id) resultInfo.set(id, { seq: e.seq, failed: e.result?.status === 'error' });
  }
  const drop = new Set<number>();
  let prev: { sig: string; callSeq: number; resultSeq?: number; failed: boolean } | null = null;
  let sawAssistant = true;
  for (const e of events) {
    if (e.kind === 'message' && e.role === 'assistant') {
      sawAssistant = true;
      continue;
    }
    if (e.kind !== 'tool_call') continue;
    const sig = `${e.tool?.name ?? ''}|${JSON.stringify(e.tool?.input ?? '')}`;
    if (prev && prev.sig === sig && !sawAssistant && prev.failed) {
      drop.add(prev.callSeq);
      if (prev.resultSeq !== undefined) drop.add(prev.resultSeq);
    }
    const info = e.tool?.call_id ? resultInfo.get(e.tool.call_id) : undefined;
    prev = { sig, callSeq: e.seq, resultSeq: info?.seq, failed: info?.failed ?? false };
    sawAssistant = false;
  }
  return events.filter((e) => !drop.has(e.seq));
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

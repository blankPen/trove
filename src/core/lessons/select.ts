/** 会话选择(Stage 3):挑出「已完成且值得提取」的会话,过滤噪声并截断。纯确定性,不调 LLM。 */
import type { Event } from '../events/schema.js';

export type SkipReason = 'too_short' | 'in_progress' | 'simple_qa' | 'no_learning_signal';

export type SessionSelection =
  | { status: 'selected'; events: Event[] }
  | { status: 'skipped'; reason: SkipReason };

export function selectSession(events: Event[], now: Date = new Date()): SessionSelection {
  if (events.length < 5) return { status: 'skipped', reason: 'too_short' };
  if (now.getTime() - updatedAtMs(events) < 5 * 60 * 1000) {
    return { status: 'skipped', reason: 'in_progress' };
  }
  if (countUserMessages(events) <= 2 && !hasError(events) && !hasToolCall(events) && !hasResourceSignal(events)) {
    return { status: 'skipped', reason: 'simple_qa' };
  }
  if (!hasError(events) && !hasCorrection(events) && !hasResourceSignal(events)) {
    return { status: 'skipped', reason: 'no_learning_signal' };
  }
  const kept = truncateEvents(filterEvents(events)).map(truncateEvent);
  return { status: 'selected', events: kept };
}

/** 会话最后活动时间 = 事件里最大的可解析 ts(毫秒);无有效 ts 记为 0,视为早就结束。 */
function updatedAtMs(events: Event[]): number {
  let max = 0;
  for (const e of events) {
    const t = Date.parse(e.ts ?? '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

function countUserMessages(events: Event[]): number {
  return events.filter((e) => e.kind === 'message' && e.role === 'user').length;
}

function hasError(events: Event[]): boolean {
  return events.some((e) => e.kind === 'tool_result' && e.result?.status === 'error');
}

function hasToolCall(events: Event[]): boolean {
  return events.some((e) => e.kind === 'tool_call');
}

/** 资源型信号:会话里出现过 URL / skill 引用,即便无 error/纠正也值得产出 resources 记忆。 */
const RESOURCE_RE = /(https?:\/\/\S+|skill:\/\/\S+)/;

function hasResourceSignal(events: Event[]): boolean {
  return events.some((e) => {
    if (e.text && RESOURCE_RE.test(e.text)) return true;
    if (typeof e.result?.output === 'string' && RESOURCE_RE.test(e.result.output)) return true;
    if (e.tool?.input !== undefined && RESOURCE_RE.test(JSON.stringify(e.tool.input))) return true;
    return false;
  });
}

// shortcut: 纠正信号用关键词启发式判定,阶段 5 由 LLM 精化。
const CORRECTION_MARKERS = [
  '不对', '错了', '纠正', '改成', '应该是', '应该用', '不是这样', '别这么做',
  'wrong', 'incorrect', 'instead', "should be", "don't", 'fix it',
];

function hasCorrection(events: Event[]): boolean {
  return events.some((e) => {
    if (e.kind !== 'message' || e.role !== 'user' || !e.text) return false;
    const t = e.text.toLowerCase();
    return CORRECTION_MARKERS.some((m) => t.includes(m));
  });
}

const TRUNCATE_MAX = 1200;

/** 超长文本截断:前 600 + `...` + 后 600;省略标记 3 字符,叠在 1200 内容预算之上。 */
export function truncateText(text: string): string {
  if (text.length <= TRUNCATE_MAX) return text;
  return `${text.slice(0, 600)}...${text.slice(-600)}`;
}

/** 有内容事件(0.4 映射):user 消息、tool_call、失败的 tool_result。 */
export function isContentfulEvent(e: Event): boolean {
  if (e.kind === 'message' && e.role === 'user') return true;
  if (e.kind === 'tool_call') return true;
  if (e.kind === 'tool_result' && e.result?.status === 'error') return true;
  return false;
}

export function filterEvents(events: Event[]): Event[] {
  return events.filter(isContentfulEvent);
}

/** 按 seq 排序后取首尾各 40(≤80 条);≤80 时原样返回(已排序)。 */
export function truncateEvents(events: Event[]): Event[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.length <= 80) return sorted;
  return [...sorted.slice(0, 40), ...sorted.slice(-40)];
}

// shortcut: 只截断顶层 text 与字符串 result.output,parts/tool.input 不截,等阶段 5 需要时再补。
function truncateEvent(e: Event): Event {
  const out = { ...e };
  if (out.text) out.text = truncateText(out.text);
  if (typeof out.result?.output === 'string') {
    out.result = { ...out.result, output: truncateText(out.result.output) };
  }
  return out;
}
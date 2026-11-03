/** 会话选择(Stage 3):只排除「仍在进行中」的会话;然后过滤掉噪音事件,保留完整对话内容(文字永不删),瘦身交给后续 Jev 压缩。纯确定性,不调模型。 */
import type { Event } from '../events/schema.js';

export type SkipReason = 'in_progress';

export type SessionSelection =
  | { status: 'selected'; events: Event[] }
  | { status: 'skipped'; reason: SkipReason };

export function selectSession(events: Event[], now: Date = new Date()): SessionSelection {
  if (now.getTime() - updatedAtMs(events) < 5 * 60 * 1000) {
    return { status: 'skipped', reason: 'in_progress' };
  }
  return { status: 'selected', events: filterEvents(events) };
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

const TRUNCATE_MAX = 1200;

/** 超长文本截断:前 600 + `...` + 后 600;省略标记 3 字符,叠在 1200 内容预算之上。按码点切,emoji 等代理对不会被劈开(按码元切会产生孤立代理项,导致 JSON.stringify 输出非法 \udXXX 转义)。 */
export function truncateText(text: string): string {
  if (text.length <= TRUNCATE_MAX) return text;
  const chars = [...text];
  return chars.length <= TRUNCATE_MAX ? text : `${chars.slice(0, 600).join('')}...${chars.slice(-600).join('')}`;
}

/** 有内容事件:user/assistant 文字消息、tool_call、tool_result(成功与失败都保留)。system/reasoning/meta 等模板噪音在此丢弃。 */
export function isContentfulEvent(e: Event): boolean {
  if (e.kind === 'message') return e.role === 'user' || e.role === 'assistant';
  if (e.kind === 'tool_call') return true;
  if (e.kind === 'tool_result') return true;
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
export function truncateEvent(e: Event): Event {
  const out = { ...e };
  if (out.text) out.text = truncateText(out.text);
  if (typeof out.result?.output === 'string') {
    out.result = { ...out.result, output: truncateText(out.result.output) };
  }
  return out;
}
import type { Event } from '../core/events/schema.js';

/** 单个字符串字段的上限。本机最大的一条 tool_result.output 是 101 MB。 */
export const MAX_FIELD = 64 * 1024;

/** 截断记录:字段路径 → 原长度。 */
export type Truncation = Record<string, number>;

function cut(text: string): { text: string; truncated?: number } {
  if (text.length <= MAX_FIELD) return { text };
  return { text: text.slice(0, MAX_FIELD), truncated: text.length };
}

/** 深截断:对象/数组里的字符串也按上限裁,避免 Write 工具的整篇文件内容漏出去。 */
function deep(value: unknown, path: string, out: Truncation, depth = 0): unknown {
  if (typeof value === 'string') {
    const r = cut(value);
    if (r.truncated !== undefined) out[path] = r.truncated;
    return r.text;
  }
  if (Array.isArray(value)) {
    if (depth > 6) return value;
    return value.map((v, i) => deep(v, `${path}[${i}]`, out, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 6) return value;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = deep(v, path ? `${path}.${k}` : k, out, depth + 1);
    return o;
  }
  return value;
}

/**
 * 截断一条事件里所有可能很大的字符串字段。
 * 原文仍在磁盘(事件文件的相对路径由调用方给出),这里只保证传输与渲染不炸。
 */
export function truncateEvent(event: Event): { event: unknown; truncated: Truncation } {
  const out: Truncation = {};
  const e: Record<string, unknown> = { ...event };

  if (typeof e['text'] === 'string') {
    const r = cut(e['text']);
    e['text'] = r.text;
    if (r.truncated !== undefined) out['text'] = r.truncated;
  }
  if (Array.isArray(e['parts'])) {
    e['parts'] = (e['parts'] as Array<Record<string, unknown>>).map((p) => {
      const q = { ...p };
      if (typeof q['text'] === 'string') {
        const r = cut(q['text']);
        q['text'] = r.text;
        if (r.truncated !== undefined) out[`parts[].text`] = r.truncated;
      }
      return q;
    });
  }
  if (e['result'] && typeof e['result'] === 'object') {
    const r = { ...(e['result'] as Record<string, unknown>) };
    if (typeof r['output'] === 'string') {
      const c = cut(r['output']);
      r['output'] = c.text;
      if (c.truncated !== undefined) out['result.output'] = c.truncated;
    }
    e['result'] = r;
  }
  if (e['tool'] && typeof e['tool'] === 'object') {
    const t = { ...(e['tool'] as Record<string, unknown>) };
    if (t['input'] !== undefined) t['input'] = deep(t['input'], 'tool.input', out);
    e['tool'] = t;
  }
  if (Object.keys(out).length) e['__truncated'] = out;
  return { event: e, truncated: out };
}

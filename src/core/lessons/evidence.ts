/** 证据强校验:quote 在事件原文中做规范化子串匹配,无证据不写。 */
import type { Event } from '../events/schema.js';
import type { EvidenceRef } from './memory.js';

export interface EvidenceCheck {
  ok: boolean;
  refs: EvidenceRef[];
  /** 校验失败条目的 seq。 */
  missing: number[];
}

const MIN_QUOTE = 12;

/** 规范化用于子串匹配:去首尾空白、连续空白折成单空格、换行折空格。 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 事件的可匹配文本:优先 text,其次字符串 result.output。 */
function candidateTexts(ev: Event): string[] {
  const out: string[] = [];
  if (typeof ev.text === 'string') out.push(normalizeForMatch(ev.text));
  if (typeof ev.result?.output === 'string') out.push(normalizeForMatch(ev.result.output));
  return out.filter((t) => t.length > 0);
}

export function verifyEvidence(
  session: string,
  raw: Array<{ seq: number; quote: string; path?: string; line?: number }>,
  events: Event[],
): EvidenceCheck {
  const bySeq = new Map<number, Event>();
  for (const e of events) bySeq.set(e.seq, e);
  const refs: EvidenceRef[] = [];
  const missing: number[] = [];
  let ok = raw.length > 0;

  for (const r of raw) {
    const needle = normalizeForMatch(r.quote);
    if (!needle || [...r.quote].length < MIN_QUOTE) {
      missing.push(r.seq);
      ok = false;
      continue;
    }
    const ev = bySeq.get(r.seq);
    if (!ev) {
      missing.push(r.seq);
      ok = false;
      continue;
    }
    if (!candidateTexts(ev).some((t) => t.includes(needle))) {
      missing.push(r.seq);
      ok = false;
      continue;
    }
    const path = r.path ?? ev.raw?.path;
    const line = r.line ?? ev.raw?.line;
    refs.push({
      session,
      seq: r.seq,
      quote: r.quote,
      ...(path ? { path } : {}),
      ...(line !== undefined ? { line } : {}),
    });
  }
  return { ok, refs, missing };
}

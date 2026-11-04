import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Event } from '../core/events/schema.js';
import { libraryDir } from '../core/layout.js';
import { loadLibraryIndex } from '../core/library/index-file.js';
import { listSessions, type SessionSummary } from '../core/sessions.js';
import { truncateEvent } from './truncate.js';

export interface SessionListQuery {
  harness?: string;
  device?: string;
  /** 正文关键词;非空时全库流式扫描,耗时数秒。 */
  q?: string;
  limit: number;
  offset: number;
}

/** 列表项:去掉本地绝对路径,只留界面要用的字段。 */
export interface SessionListItem {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  bytes: number;
  events: number;
  devices: string[];
  variants: number;
}

export interface SessionListResult {
  total: number;
  items: SessionListItem[];
}

function toItem(s: SessionSummary): SessionListItem {
  return {
    harness: s.harness,
    session: s.session,
    ...(s.title ? { title: s.title } : {}),
    ...(s.firstText ? { firstText: s.firstText } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    bytes: s.bytes,
    events: s.events,
    devices: s.devices,
    variants: s.variants,
  };
}

/**
 * 会话列表。q 非空时按正文匹配,会流式扫全部会话文件(数秒),
 * 这不建索引 —— 先按最简单的方式做,慢了再说。
 */
export async function listSessionsPage(
  vaultRoot: string,
  query: SessionListQuery,
): Promise<SessionListResult> {
  const all = await listSessions(vaultRoot, {
    ...(query.harness ? { harness: query.harness } : {}),
    ...(query.device ? { device: query.device } : {}),
    ...(query.q ? { grep: query.q } : {}),
  });
  return {
    total: all.length,
    items: all.slice(query.offset, query.offset + query.limit).map(toItem),
  };
}

/** 会话详情:规范变体 + 参与设备 + 事件总数。 */
export async function getSessionDetail(
  vaultRoot: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const index = await loadLibraryIndex(vaultRoot);
  const s = index?.sessions[key];
  if (!s) return null;
  return {
    harness: s.harness,
    session: s.session,
    ...(s.title ? { title: s.title } : {}),
    ...(s.firstText ? { firstText: s.firstText } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    sources: s.sources,
    canonical: s.canonical,
    variants: s.variants,
    eventTotal: s.canonical.events,
    /** 事件文件相对 library 根;界面用来提示"原文在磁盘上"。 */
    path: s.canonical.path,
  };
}

/**
 * 事件分页。事件文件是行式 JSONL,seq 与行号一一对应,
 * 所以 offset/limit 直接切行,不必解析全部。
 */
export async function getSessionEvents(
  vaultRoot: string,
  key: string,
  offset: number,
  limit: number,
): Promise<{ offset: number; limit: number; eventTotal: number; events: unknown[] } | null> {
  const index = await loadLibraryIndex(vaultRoot);
  const s = index?.sessions[key];
  if (!s) return null;
  const abs = join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    return { offset, limit, eventTotal: s.canonical.events, events: [] };
  }
  const events: unknown[] = [];
  let seq = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (seq >= offset && events.length < limit) {
      try {
        events.push(truncateEvent(JSON.parse(line) as Event).event);
      } catch {
        // 损坏行跳过,与 index-file 的容错口径一致
      }
    }
    seq++;
    if (events.length >= limit && seq > offset) break;
  }
  return { offset, limit, eventTotal: s.canonical.events, events };
}

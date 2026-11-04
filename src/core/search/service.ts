/** 统一查询服务：CLI 与 MCP 共用，不在这里做输出格式化。 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { computeLessonsSummary, type LessonsSummary } from '../../status.js';
import { libraryLessonsDir } from '../layout.js';
import { loadLibraryIndex } from '../library/index-file.js';
import { LessonsIndex, resolveLessonPath, type LessonDoc, type LessonHit, type LessonQuery } from './lessons-index.js';
import {
  SessionsIndex,
  type BuildStats,
  type SessionDetail,
  type SessionIndexStatus,
  type SessionSearchOptions,
} from './sessions-index.js';

export interface LessonResult extends LessonDoc {
  truncated: boolean;
}

export interface SessionSearchResult {
  results: Awaited<ReturnType<SessionsIndex['search']>>['results'];
  stale: boolean;
  degraded?: 'no_index' | 'sqlite_unavailable';
}

interface LessonsCacheEntry {
  index: LessonsIndex;
  fingerprint: number;
}

const lessonsCache = new Map<string, LessonsCacheEntry>();

export function searchDbPath(cacheDir: string): string {
  return join(cacheDir, 'search.sqlite');
}

/** lessons 的变更信号：lessons 根目录或 INDEX.md 的 mtime。learn 每次写都会更新 INDEX。 */
async function lessonsFingerprint(vaultRoot: string): Promise<number> {
  const root = libraryLessonsDir(vaultRoot);
  let fp = 0;
  for (const p of [root, join(root, 'INDEX.md')]) {
    try {
      fp = Math.max(fp, (await stat(p)).mtimeMs);
    } catch {
      // 缺失时忽略
    }
  }
  return fp;
}

export async function getLessonsIndex(vaultRoot: string): Promise<LessonsIndex> {
  const fingerprint = await lessonsFingerprint(vaultRoot);
  const cached = lessonsCache.get(vaultRoot);
  if (cached && cached.fingerprint === fingerprint) return cached.index;
  cached?.index.close();
  const index = await LessonsIndex.build(vaultRoot);
  lessonsCache.set(vaultRoot, { index, fingerprint });
  return index;
}

/** 测试/进程退出时释放内存索引。 */
export function closeSearchCache(): void {
  for (const entry of lessonsCache.values()) entry.index.close();
  lessonsCache.clear();
}

export async function searchLessons(vaultRoot: string, opts: LessonQuery): Promise<LessonHit[]> {
  const index = await getLessonsIndex(vaultRoot);
  return index.search(opts);
}

export async function listLessons(vaultRoot: string, opts: LessonQuery = {}): Promise<LessonHit[]> {
  const index = await getLessonsIndex(vaultRoot);
  return index.list(opts);
}

export interface LessonGetOptions {
  section?: string;
  lines?: string;
  full?: boolean;
  maxChars?: number;
}

export async function getLesson(
  vaultRoot: string,
  rel: string,
  opts: LessonGetOptions = {},
): Promise<LessonResult | null> {
  if (!resolveLessonPath(vaultRoot, rel)) return null;
  const index = await getLessonsIndex(vaultRoot);
  const doc = index.get(rel);
  if (!doc) return null;
  let body = doc.body;
  if (opts.section) body = sliceSection(body, opts.section) ?? '';
  if (opts.lines) body = sliceLines(body, opts.lines);
  const max = opts.full ? 64_000 : (opts.maxChars ?? 8_000);
  const truncated = body.length > max;
  return {
    ...doc,
    body: truncated ? `${body.slice(0, max)}\n…` : body,
    truncated,
  };
}

function sliceSection(body: string, heading: string): string | null {
  const lines = body.split('\n');
  const target = heading.replace(/^#+\s*/, '').trim();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2]!.trim() === target) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function sliceLines(body: string, range: string): string {
  const m = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
  if (!m) return body;
  const start = Math.max(1, Number(m[1]));
  const end = m[2] ? Math.max(start, Number(m[2])) : start;
  return body.split('\n').slice(start - 1, end).join('\n');
}

function openSessionsIndex(cacheDir: string): SessionsIndex {
  return SessionsIndex.open(searchDbPath(cacheDir));
}

export async function buildSearchIndex(
  vaultRoot: string,
  cacheDir: string,
  opts: { force?: boolean; since?: number } = {},
): Promise<BuildStats> {
  const index = openSessionsIndex(cacheDir);
  try {
    return await index.build(vaultRoot, opts);
  } finally {
    index.close();
  }
}

export async function searchSessions(
  vaultRoot: string,
  cacheDir: string,
  opts: SessionSearchOptions,
): Promise<SessionSearchResult> {
  if (!existsSync(searchDbPath(cacheDir))) {
    const index = openSessionsIndex(cacheDir);
    try {
      const exact = await index.search(vaultRoot, { ...opts, exact: true });
      return { results: exact.results, stale: false, degraded: 'no_index' };
    } finally {
      index.close();
    }
  }
  const index = openSessionsIndex(cacheDir);
  try {
    const out = await index.search(vaultRoot, opts);
    return { results: out.results, stale: out.stale };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'SQLITE_CANTOPEN') {
      const exact = await index.search(vaultRoot, { ...opts, exact: true });
      return { results: exact.results, stale: false, degraded: 'sqlite_unavailable' };
    }
    throw err;
  } finally {
    index.close();
  }
}

export async function getSession(
  vaultRoot: string,
  cacheDir: string,
  sessionId: string,
  opts: { harness?: string; around?: string; limit?: number } = {},
): Promise<SessionDetail | null> {
  const index = openSessionsIndex(cacheDir);
  try {
    return await index.get(vaultRoot, sessionId, opts);
  } finally {
    index.close();
  }
}

export interface SearchStatus {
  sessions: SessionIndexStatus & { total: number };
  lessons: LessonsSummary;
  degraded?: string;
}

export async function getSearchStatus(
  vaultRoot: string,
  cacheDir: string,
): Promise<SearchStatus> {
  const lessons = await computeLessonsSummary(vaultRoot);
  const library = await loadLibraryIndex(vaultRoot);
  const total = library ? Object.keys(library.sessions).length : 0;
  if (!existsSync(searchDbPath(cacheDir))) {
    return {
      sessions: {
        indexedSessions: 0,
        totalSessions: total,
        total,
        stale: true,
        sizeBytes: 0,
      },
      lessons,
      degraded: 'no_index',
    };
  }
  const index = openSessionsIndex(cacheDir);
  try {
    const status = await index.status(vaultRoot);
    return { sessions: { ...status, total: status.totalSessions }, lessons };
  } finally {
    index.close();
  }
}

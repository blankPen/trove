/** 统一查询服务：CLI 与 MCP 共用，不在这里做输出格式化。 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { computeLessonsSummary, type LessonsSummary } from '../../status.js';
import { libraryLessonsDir } from '../layout.js';
import { LocalStorageAdapter } from '../lessons/storage.js';
import { parseFrontmatter, stripFrontmatter } from '../lessons/frontmatter.js';
import { readMemoryUsage, recordMemoryUsageBatch, summarizeMemoryUsage } from '../lessons/memory-usage.js';
import type { MemoryAction } from '../lessons/memory-usage.js';
import { loadLibraryIndex } from '../library/index-file.js';
import { LessonsIndex, resolveLessonPath, type LessonDoc, type LessonHit, type LessonQuery } from './lessons-index.js';
import { applyUsageRanking, clip, snippetAround } from './rank.js';
import { closeQmdStore, searchQmd, type QmdHit, type QmdSearchConfig } from './qmd.js';
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

/** 检索后端配置：由 CLI/MCP 从 learn.search 映射；缺省走纯 FTS。 */
export type SearchBackendConfig = QmdSearchConfig;

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

/** 测试/进程退出时释放内存索引与 qmd 句柄。 */
export function closeSearchCache(): void {
  for (const entry of lessonsCache.values()) entry.index.close();
  lessonsCache.clear();
  void closeQmdStore();
}

export async function searchLessons(
  vaultRoot: string,
  opts: LessonQuery,
  backend?: SearchBackendConfig,
): Promise<LessonHit[]> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  let hits: LessonHit[] = [];
  // qmd 检索失败或无命中 → 落回纯 FTS；检索永远不报错。
  if (backend && opts.query?.trim()) {
    try {
      hits = await qmdSearch(vaultRoot, opts, backend);
    } catch {
      hits = [];
    }
  }
  if (hits.length === 0) {
    const index = await getLessonsIndex(vaultRoot);
    hits = index.search(opts);
  }
  try {
    // 使用反馈排序;usage 读取失败不阻断检索,保留原排序。
    hits = applyUsageRanking(hits, summarizeMemoryUsage(await readMemoryUsage(storage)), { cwd: opts.cwd });
  } catch {
    // 埋点/排序不影响检索结果
  }
  const events = hits
    .map((hit, i) => ({ id: hit.id, action: 'retrieved' as MemoryAction, rank: i + 1 }))
    .filter((e): e is { id: string; action: MemoryAction; rank: number } => !!e.id);
  await trackUsage(storage, events, opts.query);
  return hits;
}

/** qmd 命中 → LessonHit：frontmatter 语义（id/type/tags/scope）仍由 trove 自己解析。 */
async function qmdSearch(
  vaultRoot: string,
  opts: LessonQuery,
  backend: SearchBackendConfig,
): Promise<LessonHit[]> {
  const qmdHits = await searchQmd(vaultRoot, opts.query ?? '', backend, {
    ...(opts.category ? { categories: [opts.category] } : {}),
    limit: opts.limit,
  });
  return toLessonHits(vaultRoot, qmdHits, opts);
}

async function toLessonHits(
  vaultRoot: string,
  qmdHits: QmdHit[],
  opts: LessonQuery,
): Promise<LessonHit[]> {
  const root = libraryLessonsDir(vaultRoot);
  const out: LessonHit[] = [];
  for (const hit of qmdHits) {
    if (opts.category && hit.path.split('/')[0] !== opts.category) continue;
    let raw: string;
    try {
      raw = await readFile(join(root, hit.path), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const body = stripFrontmatter(raw) ?? raw;
    const type = fm?.type ?? '';
    if (opts.type && type !== opts.type && !type.startsWith(`${opts.type}/`)) continue;
    if (opts.since && fm?.updatedAt && Date.parse(fm.updatedAt) < opts.since) continue;
    out.push({
      path: hit.path,
      title: fm?.title || hit.title || basename(hit.path),
      type,
      tags: fm?.tags ?? [],
      ...(fm?.updatedAt ? { updatedAt: fm.updatedAt } : {}),
      ...(fm?.id ? { id: fm.id } : {}),
      ...(fm?.scope ? { scope: fm.scope } : {}),
      // 片段从正文里取：qmd 的分片带着 frontmatter，直接展示会像一条坏记录。
      snippet: snippetAround(body, opts.query ?? '') || clip(body, 160),
      score: hit.score,
      scoreParts: { bm25: hit.score, recency: 0, exact: 0, project: 0 },
    });
  }
  return out;
}

/** 记录使用事件;写失败静默忽略,绝不拖垮检索。 */
async function trackUsage(
  storage: LocalStorageAdapter,
  events: { id: string; action: MemoryAction; rank?: number }[],
  query?: string,
): Promise<void> {
  if (events.length === 0) return;
  const now = new Date().toISOString();
  try {
    await recordMemoryUsageBatch(
      storage,
      events.map((e) => ({
        at: now,
        memory_id: e.id,
        action: e.action,
        ...(query ? { query } : {}),
        ...(e.rank !== undefined ? { rank: e.rank } : {}),
      })),
    );
  } catch {
    // 埋点失败不阻断检索
  }
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
  if (doc.id) await trackUsage(new LocalStorageAdapter(libraryLessonsDir(vaultRoot)), [{ id: doc.id, action: 'viewed' }]);
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

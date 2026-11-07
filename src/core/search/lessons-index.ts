/** lessons 检索：进程内 FTS5 索引（911 篇 / 约 1MB，冷构建约 280ms）。 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { openSqlite, type DatabaseSync } from '../../sqlite.js';
import { libraryLessonsDir } from '../layout.js';
import { parseFrontmatter, stripFrontmatter } from '../lessons/frontmatter.js';
import {
  clip,
  exactBonus,
  projectAffinity,
  recencyBoost,
  snippetAround,
  type ScoreParts,
} from './rank.js';
import { isSingleCjkQuery, toFtsQuery, tokenizeText } from './tokenize.js';

export interface LessonDoc {
  path: string;
  title: string;
  type: string;
  tags: string[];
  /** v2 记忆 id;旧文件没有。 */
  id?: string;
  updatedAt?: string;
  /** 项目作用域 global 或 project:<slug>;无 frontmatter 的文件没有。 */
  scope?: string;
  body: string;
}

export interface LessonHit {
  path: string;
  title: string;
  type: string;
  tags: string[];
  updatedAt?: string;
  id?: string;
  scope?: string;
  snippet: string;
  score: number;
  scoreParts: ScoreParts;
}

export interface LessonQuery {
  query?: string;
  category?: string;
  type?: string;
  /** 只保留 updated_at >= since 的条目（毫秒时间戳） */
  since?: number;
  limit?: number;
  cwd?: string;
}

interface Row {
  path: string;
  title: string;
  type: string;
  tags: string;
  updated_at: string;
  score: number;
}

const SKIP_DIRS = new Set(['archive', 'audit', 'trajectories', '.trove']);
const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

/** lessons 目录下的 Markdown 相对路径（跳过 archive/audit/trajectories 与索引文件）。 */
export async function walkLessons(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walkLessons(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(childRel);
    }
  }
  return out;
}

/** lessons 相对路径必须是普通相对路径，且 resolve 后仍在 lessons 根内。 */
export function resolveLessonPath(vaultRoot: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null;
  const root = libraryLessonsDir(vaultRoot);
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

export class LessonsIndex {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly docs: Map<string, LessonDoc>,
    readonly mtimeMs: number,
  ) {}

  static async build(vaultRoot: string): Promise<LessonsIndex> {
    const root = libraryLessonsDir(vaultRoot);
    const files = await walkLessons(root);
    const docs = new Map<string, LessonDoc>();
    const db = openSqlite(':memory:', false);
    db.exec(`
      CREATE VIRTUAL TABLE lessons_fts USING fts5(
        title_tok, tags_tok, body_tok,
        path UNINDEXED, title UNINDEXED, type UNINDEXED, tags UNINDEXED, updated_at UNINDEXED,
        tokenize='unicode61'
      );
    `);
    const insert = db.prepare(
      'INSERT INTO lessons_fts(title_tok,tags_tok,body_tok,path,title,type,tags,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    );
    db.exec('BEGIN');
    try {
      for (const rel of files) {
        let raw: string;
        try {
          raw = await readFile(join(root, rel), 'utf8');
        } catch {
          continue;
        }
        const fm = parseFrontmatter(raw);
        const body = stripFrontmatter(raw) ?? raw;
        const doc: LessonDoc = {
          path: rel,
          title: fm?.title || basename(rel),
          type: fm?.type ?? '',
          tags: fm?.tags ?? [],
          ...(fm?.id ? { id: fm.id } : {}),
          ...(fm?.updatedAt ? { updatedAt: fm.updatedAt } : {}),
          ...(fm?.scope ? { scope: fm.scope } : {}),
          body,
        };
        docs.set(rel, doc);
        insert.run(
          tokenizeText(doc.title),
          tokenizeText(doc.tags.join(' ')),
          tokenizeText(body),
          doc.path,
          doc.title,
          doc.type,
          JSON.stringify(doc.tags),
          doc.updatedAt ?? '',
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(root)).mtimeMs;
    } catch {
      // 目录不存在时留 0
    }
    return new LessonsIndex(db, docs, mtimeMs);
  }

  close(): void {
    this.db.close();
  }

  search(opts: LessonQuery): LessonHit[] {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    const query = (opts.query ?? '').trim();
    if (!query) return this.list(opts);
    const now = Date.now();
    const rows: Row[] = isSingleCjkQuery(query)
      ? [...this.docs.values()]
          .filter((d) => d.title.includes(query) || d.body.includes(query))
          .map((d) => ({
            path: d.path,
            title: d.title,
            type: d.type,
            tags: JSON.stringify(d.tags),
            updated_at: d.updatedAt ?? '',
            score: 0,
          }))
      : (this.db
          .prepare(
            'SELECT path,title,type,tags,updated_at,bm25(lessons_fts,5.0,3.0,1.0) AS score ' +
              'FROM lessons_fts WHERE lessons_fts MATCH ? ORDER BY score LIMIT 300',
          )
          .all(toFtsQuery(query)) as unknown as Row[]);

    const hits: LessonHit[] = [];
    for (const row of rows) {
      if (opts.category && row.path.split('/')[0] !== opts.category) continue;
      if (opts.type && row.type !== opts.type && !row.type.startsWith(`${opts.type}/`)) continue;
      if (opts.since && row.updated_at && Date.parse(row.updated_at) < opts.since) continue;
      const doc = this.docs.get(row.path);
      const body = doc?.body ?? '';
      const tags = parseTags(row.tags);
      const parts: ScoreParts = {
        bm25: -Number(row.score) || 0,
        recency: recencyBoost(row.updated_at, 30, 1.5, now),
        exact: exactBonus(`${row.title}\n${body.slice(0, 500)}`, query),
        project: projectAffinity(opts.cwd, query),
      };
      hits.push({
        path: row.path,
        title: row.title,
        type: row.type,
        tags,
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        ...(doc?.id ? { id: doc.id } : {}),
        ...(doc?.scope ? { scope: doc.scope } : {}),
        snippet: snippetAround(body, query) || clip(body, 160),
        score: parts.bm25 + parts.recency + parts.exact + parts.project,
        scoreParts: parts,
      });
    }
    return dedupeByTitle(hits)
      .sort((a, b) => b.score - a.score || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, limit);
  }

  list(opts: LessonQuery = {}): LessonHit[] {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    return [...this.docs.values()]
      .filter((d) => !opts.category || d.path.split('/')[0] === opts.category)
      .filter((d) => !opts.type || d.type === opts.type || d.type.startsWith(`${opts.type}/`))
      .filter((d) => !opts.since || !d.updatedAt || Date.parse(d.updatedAt) >= opts.since)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((d) => ({
        path: d.path,
        title: d.title,
        type: d.type,
        tags: d.tags,
        ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
        ...(d.id ? { id: d.id } : {}),
        ...(d.scope ? { scope: d.scope } : {}),
        snippet: clip(d.body, 160),
        score: 0,
        scoreParts: { bm25: 0, recency: 0, exact: 0, project: 0 },
      }));
  }

  get(rel: string): LessonDoc | null {
    return this.docs.get(rel) ?? null;
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function dedupeByTitle(hits: LessonHit[]): LessonHit[] {
  const byTitle = new Map<string, LessonHit>();
  for (const hit of hits) {
    const prev = byTitle.get(hit.title);
    if (!prev || hit.score > prev.score) byTitle.set(hit.title, hit);
  }
  return [...byTitle.values()];
}

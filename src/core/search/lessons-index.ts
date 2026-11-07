/** lessons 文档索引：进程内读取 Markdown 元数据，供 list/get 与向量召回后映射；不做词法检索。 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { libraryLessonsDir } from '../layout.js';
import { parseFrontmatter, stripFrontmatter } from '../lessons/frontmatter.js';
import { clip, type ScoreParts } from './rank.js';

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
    private readonly docs: Map<string, LessonDoc>,
    readonly mtimeMs: number,
  ) {}

  static async build(vaultRoot: string): Promise<LessonsIndex> {
    const root = libraryLessonsDir(vaultRoot);
    const docs = new Map<string, LessonDoc>();
    for (const rel of await walkLessons(root)) {
      let raw: string;
      try {
        raw = await readFile(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      docs.set(rel, {
        path: rel,
        title: fm?.title || basename(rel),
        type: fm?.type ?? '',
        tags: fm?.tags ?? [],
        ...(fm?.id ? { id: fm.id } : {}),
        ...(fm?.updatedAt ? { updatedAt: fm.updatedAt } : {}),
        ...(fm?.scope ? { scope: fm.scope } : {}),
        body: stripFrontmatter(raw) ?? raw,
      });
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(root)).mtimeMs;
    } catch {
      // 目录不存在时留 0
    }
    return new LessonsIndex(docs, mtimeMs);
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


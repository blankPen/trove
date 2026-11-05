import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { libraryLessonsDir } from '../core/layout.js';
import { parseFrontmatter, stripFrontmatter } from '../core/lessons/frontmatter.js';
import { SIDECAR_DIRS } from '../core/lessons/sidecar.js';
import { LocalStorageAdapter } from '../core/lessons/storage.js';

export interface LessonItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  scope: string;
  source: string | null;
  createdAt?: string;
  updatedAt?: string;
  preview: string;
}

export interface LessonCategory {
  category: string;
  label: string;
  count: number;
  items: LessonItem[];
}

const LABELS = new Map(SIDECAR_DIRS.map((d) => [d.path, d.name]));
LABELS.set('archive', '归档');

/** 五类的领域序(偏好→实体→经验→决策→资源),archive 排在最后。 */
const ORDER = ['preferences', 'entities', 'experiences', 'events', 'resources', 'archive'];
const orderOf = (c: string): number => {
  const i = ORDER.indexOf(c);
  return i === -1 ? ORDER.length : i;
};

/** 不是记忆正文的文件:sidecar、索引与说明。 */
function isMemoryFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  if (!rel.endsWith('.md')) return false;
  if (base.startsWith('.')) return false;
  if (base === 'INDEX.md' || base === 'README.md') return false;
  if (rel.startsWith('trajectories/') || rel.startsWith('.trove/')) return false;
  return true;
}

/** 预览:正文首段,空白压成单空格,截到 200 字。 */
function previewOf(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * 沉淀清单:按五类(+archive)分组。
 * 内容缓存在内存 5 秒 —— 900 个文件每次重读要几百毫秒,而外部改动很少。
 */
let cache: { root: string; at: number; value: LessonCategory[] } | null = null;
const CACHE_MS = 5000;

export async function listLessons(vaultRoot: string): Promise<LessonCategory[]> {
  if (cache && cache.root === vaultRoot && Date.now() - cache.at < CACHE_MS) return cache.value;
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const files = (await storage.list('')).filter(isMemoryFile);
  const groups = new Map<string, LessonItem[]>();

  for (const rel of files) {
    const text = await storage.read(rel);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    const body = stripFrontmatter(text) ?? text;
    const category = rel.split('/')[0] ?? '';
    const item: LessonItem = {
      path: rel,
      title: fm?.title || rel.split('/').pop()!.replace(/\.md$/, ''),
      type: fm?.type ?? '',
      tags: fm?.tags ?? [],
      scope: fm?.scope ?? 'global',
      source: fm?.source ?? null,
      ...(fm?.createdAt ? { createdAt: fm.createdAt } : {}),
      ...(fm?.updatedAt ? { updatedAt: fm.updatedAt } : {}),
      preview: previewOf(body),
    };
    const list = groups.get(category) ?? [];
    list.push(item);
    groups.set(category, list);
  }

  const value: LessonCategory[] = [...groups.entries()]
    .sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      label: LABELS.get(category) ?? category,
      count: items.length,
      items: items.sort((a, b) => a.title.localeCompare(b.title)),
    }));
  cache = { root: vaultRoot, at: Date.now(), value };
  return value;
}

/** 读一个记忆文件。路径必须落在 lessons 根内。 */
export async function readLessonFile(
  vaultRoot: string,
  rel: string,
): Promise<{ path: string; content: string } | null> {
  const root = libraryLessonsDir(vaultRoot);
  // 绝对路径直接拒;相对路径归一后必须仍在 root 之下(挡住 ../)
  if (rel.startsWith('/') || rel.includes('\\')) return null;
  const abs = join(root, ...rel.split('/'));
  if (!abs.startsWith(root + sep)) return null;
  try {
    const content = await readFile(abs, 'utf8');
    return { path: rel, content };
  } catch {
    return null;
  }
}

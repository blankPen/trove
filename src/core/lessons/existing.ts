/** 阶段 6 前置:从 lessons 目录读回现有记忆,供合并去重。只认带合法 frontmatter 的记忆文件,忽略审计/归档/元数据。 */
import type { ExistingMemory } from './merge.js';
import type { StorageAdapter } from './storage.js';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';

/** 非记忆文件(元数据/审计),不参与合并。 */
const NON_MEMORY = new Set(['INDEX.md', '.overview.md', 'memory_diff.json', 'README.md']);

export async function loadExistingMemories(storage: StorageAdapter): Promise<ExistingMemory[]> {
  const files = await storage.list();
  const out: ExistingMemory[] = [];
  for (const path of files) {
    if (path.startsWith('archive/') || path.startsWith('audit/')) continue;
    if (NON_MEMORY.has(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    out.push({ type: fm.type, path, title: fm.title, content: (stripFrontmatter(text) ?? '').trim() });
  }
  return out;
}
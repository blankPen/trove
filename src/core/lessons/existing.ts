/** 阶段 6 前置:从 lessons 目录读回现有记忆,供合并去重。只认带合法 frontmatter 的记忆文件,忽略审计/归档/元数据。 */
import type { ExistingMemory } from './merge.js';
import type { ExistingForGate } from './gateway.js';
import type { StorageAdapter } from './storage.js';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';
import { parseMemory } from './memory.js';

/** 非记忆文件(元数据/审计),不参与合并。 */
const NON_MEMORY = new Set(['INDEX.md', '.overview.md', 'memory_diff.json', 'README.md']);
const SKIP_PREFIXES = ['archive/', 'audit/', 'trajectories/', '.trove/'];

function isMemoryPath(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return false;
  return !NON_MEMORY.has(path);
}

export async function loadExistingMemories(storage: StorageAdapter): Promise<ExistingMemory[]> {
  const files = await storage.list();
  const out: ExistingMemory[] = [];
  for (const path of files) {
    if (!isMemoryPath(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    out.push({ type: fm.type, path, title: fm.title, content: (stripFrontmatter(text) ?? '').trim() });
  }
  return out;
}

/** v2 合并用:带 id 的现有记忆(parseMemory 对 v1 文件也回退补默认)。 */
export async function loadExistingForGate(storage: StorageAdapter): Promise<ExistingForGate[]> {
  const files = await storage.list();
  const out: ExistingForGate[] = [];
  for (const path of files) {
    if (!isMemoryPath(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const mem = parseMemory(text);
    if (!mem) continue;
    out.push({
      id: mem.id || undefined,
      path,
      title: mem.title,
      content: mem.body.trim(),
      type: mem.type,
      scope: mem.scope,
      ...(mem.quality ? { quality: mem.quality } : {}),
      useCount: mem.useCount,
    });
  }
  return out;
}
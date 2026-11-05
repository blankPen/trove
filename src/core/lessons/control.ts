/** 用户控制:固定(pin)/取消固定/忘掉(forget)/恢复(restore)记忆。 */
import { setFrontmatterField } from './frontmatter.js';
import { parseMemory } from './memory.js';
import { listMemoryFiles } from './curator.js';
import type { MemoryFile } from './curator.js';
import { addIndexEntry, removeIndexEntry } from './write.js';
import type { StorageAdapter } from './storage.js';

/** 忘掉后的存放目录(相对 lessons 根),按 ISO 时间分目录。 */
const FORGOTTEN_DIR = '.trove/forgotten';
/** 归档目录(恢复的默认来源)。 */
const ARCHIVE_DIR = 'archive';

/** 按 id 或相对路径找记忆文件;找不到返回 null。 */
export async function findMemoryFile(storage: StorageAdapter, ref: string): Promise<MemoryFile | null> {
  const files = await listMemoryFiles(storage);
  return files.find((f) => f.path === ref || (f.memory.id !== '' && f.memory.id === ref)) ?? null;
}

/** 在指定目录(默认 archive/)里按 id 或相对路径找已归档的记忆。 */
export async function findArchivedFile(
  storage: StorageAdapter,
  ref: string,
  fromDir: string = ARCHIVE_DIR,
): Promise<{ path: string; text: string } | null> {
  const dir = fromDir.replace(/\/+$/, '');
  if (ref.includes('/')) {
    const path = `${dir}/${ref}`;
    const text = await storage.read(path);
    return text === null ? null : { path, text };
  }
  for (const path of await storage.list(dir)) {
    if (!path.endsWith('.md')) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const mem = parseMemory(text);
    if (mem && mem.id === ref) return { path, text };
  }
  return null;
}

/** 设置/清除 pinned;返回命中的文件,找不到返回 null。 */
export async function setPinned(
  storage: StorageAdapter,
  ref: string,
  pinned: boolean,
): Promise<MemoryFile | null> {
  const f = await findMemoryFile(storage, ref);
  if (!f) return null;
  const text = pinned
    ? setFrontmatterField(f.text, 'pinned', 'true')
    : setFrontmatterField(f.text, 'pinned', null);
  await storage.write(f.path, text);
  return f;
}

/** 忘掉:文件移到 `.trove/forgotten/<ISO>/<path>`(内容保留),并清 INDEX 行。 */
export async function forgetMemory(
  storage: StorageAdapter,
  ref: string,
  now: () => Date = () => new Date(),
): Promise<{ path: string; target: string } | null> {
  const f = await findMemoryFile(storage, ref);
  if (!f) return null;
  const target = `${FORGOTTEN_DIR}/${now().toISOString()}/${f.path}`;
  await storage.write(target, f.text);
  await storage.delete(f.path);
  await removeIndexEntry(storage, f.path);
  return { path: f.path, target };
}

/** 恢复:从 archive/(或 --from 指定的目录)移回原路径,status 置 active 并补 INDEX 行。 */
export async function restoreMemory(
  storage: StorageAdapter,
  ref: string,
  opts: { from?: string } = {},
): Promise<{ path: string } | null> {
  const from = (opts.from ?? ARCHIVE_DIR).replace(/\/+$/, '');
  const found = await findArchivedFile(storage, ref, from);
  if (!found) return null;
  const original = found.path.slice(from.length + 1);
  const mem = parseMemory(found.text);
  await storage.write(original, setFrontmatterField(found.text, 'status', 'active'));
  await storage.delete(found.path);
  if (mem) {
    await addIndexEntry(storage, {
      type: mem.type,
      title: mem.title,
      path: original,
      content: mem.body,
    });
  }
  return { path: original };
}

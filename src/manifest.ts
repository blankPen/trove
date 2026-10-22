import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Manifest } from './core/types.js';

/** 读取 manifest;不存在则返回空对象。损坏 JSON 抛含路径的错误。 */
export async function loadManifest(path: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    throw new Error(`manifest 损坏,无法解析 JSON: ${path}`);
  }
}

/** 原子写入 manifest(临时文件 + rename)。 */
export async function saveManifest(
  path: string,
  manifest: Manifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.manifest.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

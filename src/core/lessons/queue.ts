/** learn 待办队列:sync 把「本轮新会话」追加进来,learn 循环按批取出并移除。崩溃重启后不丢。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireLock } from '../lock.js';

/** 读队列;文件缺失或损坏按空队处理,不拖垮调用方。 */
export async function readLearnQueue(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeLearnQueue(path: string, ids: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(ids, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

/** 追加 ids 到队尾,去重(已存在的不动);sync 每轮入队与 learn 每 tick 出队互斥。 */
export async function enqueueLearn(path: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const release = await acquireLock(`${path}.lock`);
  try {
    const existing = await readLearnQueue(path);
    const seen = new Set(existing);
    for (const id of ids) seen.add(id);
    await writeLearnQueue(path, [...seen]);
  } finally {
    await release();
  }
}

/** 移除指定 ids(处理完/失败都算「已处理」),保留其余。 */
export async function removeLearn(path: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const release = await acquireLock(`${path}.lock`);
  try {
    const existing = await readLearnQueue(path);
    const drop = new Set(ids);
    await writeLearnQueue(path, existing.filter((id) => !drop.has(id)));
  } finally {
    await release();
  }
}

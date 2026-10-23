import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跨进程互斥锁(daemon 与手动 sync 不能同时写同一份 vault/state)。
 * 陈旧锁(进程已死)自动接管;释放时校验 token,避免误删别人的锁。
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }));
      await fh.close();
      return async () => {
        try {
          const cur = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
          if (cur.token === token) await unlink(path);
        } catch {
          // 锁已不存在
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let existing: { pid?: number } | null = null;
      try {
        existing = JSON.parse(await readFile(path, 'utf8')) as { pid?: number };
      } catch {
        existing = null;
      }
      if (existing && typeof existing.pid === 'number' && isProcessAlive(existing.pid)) {
        throw new Error(`已有同步在运行 (pid ${existing.pid}),请等待其结束`);
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new Error('无法获取同步锁');
}

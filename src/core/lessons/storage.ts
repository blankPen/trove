/** lessons 落盘的最小文本读写抽象。本地实现直接 fs;远端由现有 sync 引擎(RemoteStore)承担,不在此重复。 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StorageAdapter {
  /** 读取文本;不存在返回 null。 */
  read(path: string): Promise<string | null>;
  /** 覆盖写入文本(自动建父目录)。 */
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 删除文件;不存在静默成功。 */
  delete(path: string): Promise<void>;
  /** 递归列出 prefix 下的相对文件路径(`/` 分隔);不存在返回空数组。 */
  list(prefix?: string): Promise<string[]>;
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private root: string) {}

  private abs(path: string): string {
    return join(this.root, path);
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.abs(path), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async write(path: string, text: string): Promise<void> {
    const abs = this.abs(path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomUUID()}`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, abs);
  }

  async delete(path: string): Promise<void> {
    await rm(this.abs(path), { force: true });
  }

  async list(prefix = ''): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在
      }
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), p);
        else if (e.isFile()) out.push(p);
      }
    };
    await walk(this.abs(prefix), prefix);
    return out;
  }
}

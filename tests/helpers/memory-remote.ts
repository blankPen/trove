import { readFile, stat, writeFile } from 'node:fs/promises';

/**
 * 内存远端:模拟 WebDAV 的 6 个原语,记录写操作便于断言"增量只传新块"。
 * 仅测试用。
 */
export class MemoryRemote {
  readonly files = new Map<string, Buffer>();
  readonly writes: string[] = [];
  readonly reads: string[] = [];

  async listDevices(): Promise<string[]> {
    const out = new Set<string>();
    for (const p of this.files.keys()) {
      const m = /^raw\/([^/]+)\//.exec(p);
      if (m) out.add(m[1]!);
    }
    return [...out].sort();
  }

  async list(path: string): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number }>> {
    const prefix = path.replace(/^\/+|\/+$/g, '');
    const out = new Map<string, { name: string; type: 'file' | 'directory'; size: number }>();
    for (const [p, b] of this.files) {
      if (!p.startsWith(`${prefix}/`)) continue;
      const rest = p.slice(prefix.length + 1);
      const [name, ...tail] = rest.split('/');
      if (!name) continue;
      out.set(name, {
        name,
        type: tail.length ? 'directory' : 'file',
        size: tail.length ? 0 : b.length,
      });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async readJson(path: string): Promise<unknown | null> {
    const b = this.files.get(path);
    return b ? (JSON.parse(b.toString('utf8')) as unknown) : null;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    this.files.set(path, Buffer.from(JSON.stringify(value), 'utf8'));
    this.writes.push(path);
  }

  async writeFile(
    path: string,
    localPath: string,
    range?: { offset: number; length: number },
  ): Promise<void> {
    const all = await readFile(localPath);
    this.files.set(
      path,
      range ? all.subarray(range.offset, range.offset + range.length) : all,
    );
    this.writes.push(path);
  }

  async readFile(path: string, localPath: string): Promise<void> {
    const b = this.files.get(path);
    if (!b) throw new Error(`远端文件不存在: ${path}`);
    this.reads.push(path);
    await writeFile(localPath, b);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.writes.push(path);
  }

  async fileSize(path: string): Promise<number> {
    return (await stat(path)).size;
  }

  /** 测试断言:按前缀统计文件数。 */
  count(prefix: string): number {
    let n = 0;
    for (const p of this.files.keys()) if (p.startsWith(prefix)) n++;
    return n;
  }
}

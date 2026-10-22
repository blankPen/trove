import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createClient, type WebDAVClient } from 'webdav';
import type { Remote, RemoteFile } from './types.js';

export interface WebDavOptions {
  url: string;
  username?: string;
  password?: string;
}

/** 去掉前导 '/',使远端路径统一为相对形式(如 'a3f2c81e/...')。 */
function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

/** 给相对路径补前导 '/',适配 webdav 客户端方法。 */
function withSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * WebDAV 远端实现(设计 §12:webdav npm 包)。
 * 字节一致:download 用 binary 读,upload 用流写。
 */
export class WebDavRemote implements Remote {
  private client: WebDAVClient;

  constructor(opts: WebDavOptions) {
    this.client = createClient(opts.url, {
      username: opts.username,
      password: opts.password,
    });
  }

  async listAll(): Promise<RemoteFile[]> {
    const contents = await this.client.getDirectoryContents('/', { deep: true });
    const out: RemoteFile[] = [];
    for (const c of contents) {
      if (c.type !== 'file') continue;
      out.push({ path: stripLeadingSlash(c.filename), size: c.size });
    }
    return out;
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const data = await this.client.getFileContents(withSlash(remotePath), {
      format: 'binary',
    });
    await writeFile(localPath, data as Buffer);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.ensureDir(remotePath);
    await this.client.putFileContents(withSlash(remotePath), createReadStream(localPath));
  }

  async delete(remotePath: string): Promise<void> {
    await this.client.deleteFile(withSlash(remotePath));
  }

  /** 逐段 MKCOL 创建父目录;已存在(405/409)则忽略。 */
  private async ensureDir(remotePath: string): Promise<void> {
    const segments = remotePath.split('/');
    segments.pop(); // 去掉文件名本身
    let acc = '';
    for (const seg of segments) {
      if (!seg) continue;
      acc += `/${seg}`;
      try {
        await this.client.createDirectory(acc, { recursive: true });
      } catch (err) {
        const status = (err as { status?: number }).status;
        // 405 Method Not Allowed / 409 Conflict = 目录已存在
        if (status !== 405 && status !== 409) throw err;
      }
    }
  }
}

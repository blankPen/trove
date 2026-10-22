import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { v2 as webdav } from 'webdav-server';
import { WebDavRemote } from '../src/remote/webdav.js';

/** webdav-server 把 port 0 当默认 1900,这里显式找一个空闲端口。 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('WebDavRemote(真实 WebDAV 服务端集成)', () => {
  let server: webdav.WebDAVServer;
  let httpServer: Server;
  let remote: WebDavRemote;
  let dir: string;

  beforeAll(async () => {
    const userManager = new webdav.SimpleUserManager();
    const user = userManager.addUser('trove', 'secret', false);
    const privilegeManager = new webdav.SimplePathPrivilegeManager();
    privilegeManager.setRights(user, '/', ['all']);

    const port = await getFreePort();
    server = new webdav.WebDAVServer({
      port,
      maxRequestDepth: Infinity, // 允许 Depth: infinity 的深度 PROPFIND
      httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'trove-test'),
      privilegeManager,
    });
    httpServer = await server.startAsync(port);
    remote = new WebDavRemote({
      url: `http://127.0.0.1:${port}`,
      username: 'trove',
      password: 'secret',
    });
    dir = await mkdtemp(join(tmpdir(), 'trove-webdav-'));
  });

  afterAll(async () => {
    await server.stopAsync();
    await rm(dir, { recursive: true, force: true });
  });

  it('upload 后 listAll 返回正确路径与大小', async () => {
    const local = join(dir, 'a.jsonl');
    await writeFile(local, 'hello world\n');

    await remote.upload(local, 'a3f2c81e/claude-code/projects/-p/a.jsonl');

    const files = await remote.listAll();
    const got = files.find((f) => f.path === 'a3f2c81e/claude-code/projects/-p/a.jsonl');
    expect(got).toBeDefined();
    expect(got!.size).toBe('hello world\n'.length);
  });

  it('upload → download 字节级 round-trip', async () => {
    const content = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x7f, 0x80, 0x01]);
    const local = join(dir, 'bin.jsonl');
    await writeFile(local, content);

    await remote.upload(local, 'a3f2c81e/claude-code/projects/-p/bin.jsonl');

    const dl = join(dir, 'bin.downloaded');
    await remote.download('a3f2c81e/claude-code/projects/-p/bin.jsonl', dl);
    const got = await readFile(dl);
    expect(got.equals(content)).toBe(true);
  });

  it('upload 自动创建多级父目录', async () => {
    const local = join(dir, 'deep.jsonl');
    await writeFile(local, 'deep\n');

    // 三层父目录均不存在
    await remote.upload(local, 'dev/x/y/z/deep.jsonl');

    const files = await remote.listAll();
    expect(files.some((f) => f.path === 'dev/x/y/z/deep.jsonl')).toBe(true);
  });

  it('listAll 不返回目录,只返回文件', async () => {
    const local = join(dir, 'only-file.jsonl');
    await writeFile(local, 'x\n');
    await remote.upload(local, 'top/only-file.jsonl');

    const files = await remote.listAll();
    const dirs = files.filter((f) => f.path.endsWith('/'));
    expect(dirs).toHaveLength(0);
  });

  it('delete 后 listAll 不再返回该文件(init 连通性探针依赖)', async () => {
    const local = join(dir, 'todelete.jsonl');
    await writeFile(local, 'bye\n');
    await remote.upload(local, 'a3f2c81e/todelete.jsonl');

    await remote.delete('a3f2c81e/todelete.jsonl');

    const files = await remote.listAll();
    expect(files.some((f) => f.path === 'a3f2c81e/todelete.jsonl')).toBe(false);
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v2 as webdav } from 'webdav-server';
import { WebDavStore } from '../src/remote/webdav-store.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
    s.on('error', reject);
  });
}

describe('WebDavStore(真实服务端集成)', () => {
  let server: webdav.WebDAVServer;
  let store: WebDavStore;
  let dir: string;

  beforeAll(async () => {
    const um = new webdav.SimpleUserManager();
    const user = um.addUser('trove', 'secret', false);
    const pm = new webdav.SimplePathPrivilegeManager();
    pm.setRights(user, '/', ['all']);
    const port = await freePort();
    server = new webdav.WebDAVServer({
      port,
      maxRequestDepth: Infinity,
      httpAuthentication: new webdav.HTTPBasicAuthentication(um, 'trove-test'),
      privilegeManager: pm,
    });
    await server.startAsync(port);
    store = new WebDavStore({
      url: `http://127.0.0.1:${port}`,
      username: 'trove',
      password: 'secret',
    });
    dir = await mkdtemp(join(tmpdir(), 'trove-dav-'));
  });

  afterAll(async () => {
    await server.stopAsync();
    await rm(dir, { recursive: true, force: true });
  });

  it('JSON 写入 → 读回一致;不存在返回 null', async () => {
    const value = { v: 1, items: { 'a:b': { size: 3 } }, 中文: '值' };
    await store.writeJson('dev1/index.json', value);
    await expect(store.readJson('dev1/index.json')).resolves.toEqual(value);
    await expect(store.readJson('dev1/nope.json')).resolves.toBeNull();
  });

  it('二进制块区间上传 → 读回字节一致', async () => {
    const local = join(dir, 'blob.bin');
    const all = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(local, all);

    await store.writeFile('dev1/h/k/g1/0004-4.bin', local, { offset: 4, length: 4 });
    const got = join(dir, 'got.bin');
    await store.readFile('dev1/h/k/g1/0004-4.bin', got);
    expect((await readFile(got)).equals(all.subarray(4, 8))).toBe(true);
  });

  it('多级目录自动创建,listDevices 只返回 raw/ 下的设备目录', async () => {
    const local = join(dir, 'x.bin');
    await writeFile(local, 'x');
    await store.writeFile('raw/devA/claude-code/K/g1/0000-1.bin', local);
    await store.writeJson('raw/devB/index.json', { v: 1 });
    await store.writeJson('library/index/devC.json', { v: 1 });
    const devices = await store.listDevices();
    expect(devices).toEqual(expect.arrayContaining(['devA', 'devB']));
    expect(devices).not.toContain('devC');
    expect(devices).not.toContain('library');
  });

  it('删除不存在文件不报错', async () => {
    await expect(store.delete('dev1/never-existed')).resolves.toBeUndefined();
  });
});

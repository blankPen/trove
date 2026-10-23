import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v2 as webdav } from 'webdav-server';
import { WebDavStore } from '../src/remote/webdav-store.js';
import { sync } from '../src/core/sync.js';
import { pullRemote } from '../src/core/pull.js';
import { emptyState } from '../src/core/state.js';
import { indexPath, type DeviceIndex } from '../src/core/remote-layout.js';
import type { Adapter } from '../src/adapters/index.js';

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

describe('E2E(真实 WebDAV):同步 / 增量 / 跨设备拉取 / 不删除', () => {
  let server: webdav.WebDAVServer;
  let remote: WebDavStore;
  let src: string;
  let vault1: string;
  let vault2: string;

  const adapter = (): Adapter => ({
    kind: 'files',
    id: 'claude-code',
    displayName: 'Claude Code',
    source: {
      id: 'claude-code',
      displayName: 'Claude Code',
      root: src,
      patterns: ['**/*.jsonl'],
      exclusions: [],
    },
  });

  const syncOpts = (vault: string, deviceId: string) => ({
    adapters: [adapter()],
    deviceId,
    deviceName: deviceId,
    vaultRoot: vault,
    statePath: join(vault, 'state.json'),
    tmpDir: join(vault, 'tmp'),
    remote,
    cutoff: 0,
    chunkSize: 4,
    now: () => 1000,
  });

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
    remote = new WebDavStore({ url: `http://127.0.0.1:${port}`, username: 'trove', password: 'secret' });

    src = await mkdtemp(join(tmpdir(), 'trove-e2e-src-'));
    vault1 = await mkdtemp(join(tmpdir(), 'trove-e2e-v1-'));
    vault2 = await mkdtemp(join(tmpdir(), 'trove-e2e-v2-'));
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(join(src, 'projects/a.jsonl'), '0123456789');
  });

  afterAll(async () => {
    await server.stopAsync();
  });

  it('同步 → 远端索引与块可读;追加 → 只传新块', async () => {
    const r1 = await sync(syncOpts(vault1, 'dev1'));
    expect(r1.pushed.uploadedItems).toBe(1);
    const idx = (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
    const item = Object.values(idx.items)[0]!;
    expect(item.size).toBe(10);
    expect(item.chunks).toHaveLength(3);

    await writeFile(join(src, 'projects/a.jsonl'), '0123456789WXYZ');
    const r2 = await sync(syncOpts(vault1, 'dev1'));
    expect(r2.pushed.uploadedChunks).toBe(2);

    const idx2 = (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
    const item2 = Object.values(idx2.items)[0]!;
    expect(item2.size).toBe(14);
    expect(item2.chunks.map((c) => c.offset)).toEqual([0, 4, 8, 12]);
  });

  it('第二台设备拉取 → 字节完全一致', async () => {
    const r = await pullRemote({
      remote,
      deviceId: 'dev2',
      vaultRoot: vault2,
      state: emptyState(),
      chunkSize: 4,
    });
    expect(r.downloadedItems).toBe(1);
    const local = join(vault2, 'raw/dev1/claude-code/projects/a.jsonl');
    expect(await readFile(local, 'utf8')).toBe('0123456789WXYZ');
  });

  it('源文件删除 → 远端仍保留(只增不删)', async () => {
    await unlink(join(src, 'projects/a.jsonl'));
    await sync(syncOpts(vault1, 'dev1'));
    const idx = (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
    expect(Object.values(idx.items)[0]!.size).toBe(14);
    const local = join(vault1, 'raw/dev1/claude-code/projects/a.jsonl');
    expect(await readFile(local, 'utf8')).toBe('0123456789WXYZ');
  });
});

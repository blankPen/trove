import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { v2 as webdav } from 'webdav-server';
import { run } from '../src/cli.js';
import type { Source } from '../src/adapters/types.js';

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

describe('端到端:init → sync(真实 WebDAV 服务)', () => {
  let server: webdav.WebDAVServer;
  let httpServer: Server;
  let port: number;
  const bases: string[] = [];

  beforeAll(async () => {
    const userManager = new webdav.SimpleUserManager();
    const user = userManager.addUser('trove', 'secret', false);
    const privilegeManager = new webdav.SimplePathPrivilegeManager();
    privilegeManager.setRights(user, '/', ['all']);

    port = await getFreePort();
    server = new webdav.WebDAVServer({
      port,
      maxRequestDepth: Infinity,
      httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'trove-e2e'),
      privilegeManager,
    });
    httpServer = await server.startAsync(port);
  });

  afterAll(async () => {
    await server.stopAsync();
    for (const b of bases) await rm(b, { recursive: true, force: true });
  });

  it('设备 A 归档推送,设备 B 拉取并字节一致', async () => {
    const url = `http://127.0.0.1:${port}`;

    // ── 设备 A:init + sync(collect 内联在 sync 里)──
    const baseA = mkdtempSync(join(tmpdir(), 'trove-e2e-a-'));
    bases.push(baseA);
    const srcRoot = join(baseA, 'claude-src');
    await mkdir(join(srcRoot, 'projects', '-p'), { recursive: true });
    await writeFile(join(srcRoot, 'projects', '-p', 'a.jsonl'), 'hello from e2e\n');
    const source: Source = {
      id: 'claude-code',
      displayName: 'Claude Code',
      root: srcRoot,
      patterns: ['projects/**/*.jsonl'],
      exclusions: [],
      mapToVaultPath: (abs) => join('claude-code', relative(srcRoot, abs)),
    };
    const depsA = { base: baseA, resolveSources: () => [source] };

    expect(await run(['init', '--name', 'devA', '--url', url, '--username', 'trove', '--password', 'secret'], depsA)).toBe(0);
    expect(await run(['sync'], depsA)).toBe(0);

    const cfgA = JSON.parse(await readFile(join(baseA, 'config.json'), 'utf8')) as { device: { id: string } };
    const deviceA = cfgA.device.id;

    // ── 设备 B:init + sync(无本地数据,只 pull)──
    const baseB = mkdtempSync(join(tmpdir(), 'trove-e2e-b-'));
    bases.push(baseB);
    const depsB = { base: baseB, resolveSources: () => [] };

    expect(await run(['init', '--name', 'devB', '--url', url, '--username', 'trove', '--password', 'secret'], depsB)).toBe(0);
    expect(await run(['sync'], depsB)).toBe(0);

    // A 的文件被 B 拉到 vault/devices/{A}/...
    const pulled = await readFile(
      join(baseB, 'vault', 'devices', deviceA, 'claude-code', 'projects', '-p', 'a.jsonl'),
      'utf8',
    );
    expect(pulled).toBe('hello from e2e\n');
  });
});

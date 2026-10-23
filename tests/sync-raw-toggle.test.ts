import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sync } from '../src/core/sync.js';
import { indexPath, type DeviceIndex } from '../src/core/remote-layout.js';
import type { Adapter } from '../src/adapters/index.js';
import { MemoryRemote } from './helpers/memory-remote.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

function adapter(root: string): Adapter {
  return {
    kind: 'files',
    id: 'claude-code',
    displayName: 'Claude Code',
    source: {
      id: 'claude-code',
      displayName: 'Claude Code',
      root,
      patterns: ['projects/**/*.jsonl'],
      exclusions: [],
      sessionPatterns: ['projects/**/*.jsonl'],
    },
  };
}

function sessionBody(): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:00.000Z',
        message: { role: 'user', content: '你好' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

async function setup() {
  const src = await tmp('trove-raw-src-');
  const vault = await tmp('trove-raw-vault-');
  await mkdir(join(src, 'projects'), { recursive: true });
  await writeFile(join(src, 'projects/p1.jsonl'), sessionBody());
  const remote = new MemoryRemote();
  return {
    src,
    vault,
    remote,
    opts: {
      adapters: [adapter(src)],
      deviceId: 'dev1',
      deviceName: '本机',
      vaultRoot: vault,
      statePath: join(vault, 'state.json'),
      tmpDir: join(vault, 'tmp'),
      remote,
      cutoff: 0,
    },
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out;
}

describe('raw 同步开关', () => {
  it('rawSync=false 时只推送 library,远端没有 raw 索引', async () => {
    const { remote, opts } = await setup();

    const report = await sync({ ...opts, rawSync: false });
    expect(report.library.pushed.uploaded).toBeGreaterThan(0);

    expect(await remote.readJson(indexPath('dev1'))).toBeNull();
    expect(remote.files.has('library/index/dev1.json')).toBe(true);
    expect([...remote.files.keys()].some((p) => p.startsWith('library/sessions/'))).toBe(true);
    expect([...remote.files.keys()].some((p) => p.startsWith('raw/'))).toBe(false);

    // 打开 raw 后,raw 索引才会出现
    await sync(opts);
    const index = (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
    expect(Object.keys(index.items).length).toBeGreaterThan(0);
  });

  it('rawSync=false 时拉取只落地 library', async () => {
    const { remote, opts } = await setup();
    await sync(opts); // 设备 A 全量同步

    const vaultB = await tmp('trove-raw-vault-b-');
    await sync({
      ...opts,
      deviceId: 'dev2',
      deviceName: '另一台',
      vaultRoot: vaultB,
      statePath: join(vaultB, 'state.json'),
      tmpDir: join(vaultB, 'tmp'),
      adapters: [],
      pullOnly: true,
      rawSync: false,
    });

    const files = await filesUnder(vaultB);
    expect(files.some((p) => p.includes('/library/sessions/'))).toBe(true);
    expect(files.some((p) => p.includes('/library/index/dev1.json'))).toBe(true);
    expect(files.some((p) => p.includes('/raw/dev1/'))).toBe(false);
  });
});

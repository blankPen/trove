import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sync } from '../src/core/sync.js';
import { loadState } from '../src/core/state.js';
import { indexPath, metaPath, type DeviceIndex } from '../src/core/remote-layout.js';
import type { Adapter } from '../src/adapters/index.js';
import type { Progress } from '../src/progress.js';
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
      patterns: ['**/*.jsonl'],
      exclusions: [],
    },
  };
}

async function setup(body = 'hello world') {
  const src = await tmp('trove-s-src-');
  const vault = await tmp('trove-s-vault-');
  await mkdir(join(src, 'projects'), { recursive: true });
  await writeFile(join(src, 'projects/a.jsonl'), body);
  const remote = new MemoryRemote();
  const opts = {
    adapters: [adapter(src)],
    deviceId: 'dev1',
    deviceName: '本机',
    vaultRoot: vault,
    statePath: join(vault, 'state.json'),
    tmpDir: join(vault, 'tmp'),
    remote,
    cutoff: 0,
    chunkSize: 4,
    now: () => 999,
  };
  return { src, vault, remote, opts, source: join(src, 'projects/a.jsonl') };
}

async function myIndex(remote: MemoryRemote): Promise<DeviceIndex> {
  return (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
}

describe('sync(collect → pull → push)', () => {
  it('首次同步:归档 + 上传 + 落状态 + 写设备 meta', async () => {
    const { opts, remote, vault } = await setup();

    const report = await sync(opts);

    expect(report.collected.archived).toBe(1);
    expect(report.pushed.uploadedItems).toBe(1);
    const item = Object.values((await myIndex(remote)).items)[0]!;
    expect(item.size).toBe(11);
    expect(item.chunks).toHaveLength(3);
    expect(await remote.readJson(metaPath('dev1'))).toMatchObject({ id: 'dev1', name: '本机' });

    const state = await loadState(join(vault, 'state.json'));
    expect(state.sources['claude-code']!['projects/a.jsonl']).toBeDefined();
    expect(state.pushed['claude-code']!['projects/a.jsonl']!.size).toBe(11);
  });

  it('第二次同步无变化 → 零上传零复制', async () => {
    const { opts, remote } = await setup();
    await sync(opts);
    const chunkWrites = remote.writes.filter((w) => w.endsWith('.bin')).length;

    const report = await sync(opts);

    expect(report.collected.skipped).toBe(1);
    expect(report.pushed.uploadedChunks).toBe(0);
    expect(remote.writes.filter((w) => w.endsWith('.bin')).length).toBe(chunkWrites);
  });

  it('源文件增长 → 只上传新块,远端索引大小跟进', async () => {
    const { opts, remote, source } = await setup('0123456789');
    await sync(opts);
    const before = remote.writes.filter((w) => w.endsWith('.bin')).length;

    await writeFile(source, '0123456789WXYZ');
    const report = await sync(opts);

    expect(report.collected.appended).toBe(1);
    expect(remote.writes.filter((w) => w.endsWith('.bin')).length - before).toBe(2);
    const item = Object.values((await myIndex(remote)).items)[0]!;
    expect(item.size).toBe(14);
  });

  it('--since 过滤窗口外的旧会话:不归档也不上传,但状态文件仍生成', async () => {
    const { opts, remote, source, vault } = await setup();
    const old = new Date(Date.now() - 30 * 86400_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(source, old, old);

    const report = await sync({ ...opts, cutoff: Date.now() - 7 * 86400_000 });

    expect(report.collected.outOfWindow).toBe(1);
    expect(report.pushed.uploadedItems).toBe(0);
    expect([...remote.files.keys()].filter((k) => k.includes('index.json') || k.endsWith('.bin'))).toEqual([]);
    await expect(loadState(join(vault, 'state.json'))).resolves.toBeDefined();
  });

  it('上报 collect / pull / push 三个阶段', async () => {
    const { opts } = await setup();
    const phases: string[] = [];
    const progress: Progress = { phase: (n) => phases.push(n), item: () => {} };

    await sync({ ...opts, progress });

    expect(phases).toEqual(['collect', 'pull', 'library', 'push']);
  });

  it('pullOnly 只拉不推', async () => {
    const { opts, remote } = await setup();
    const report = await sync({ ...opts, pullOnly: true });
    expect(report.pushed.uploadedItems).toBe(0);
    expect(remote.files.size).toBe(0);
  });
});

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pullRemote } from '../src/core/pull.js';
import { emptyState } from '../src/core/state.js';
import {
  chunkRemotePath,
  chunksHash,
  encodeKey,
  indexPath,
  itemKey,
  type DeviceIndex,
  type IndexItem,
} from '../src/core/remote-layout.js';
import type { ChunkRef } from '../src/core/chunker.js';
import { MemoryRemote } from './helpers/memory-remote.js';

const CH = 4;

async function vault() {
  return mkdtemp(join(tmpdir(), 'trove-pull-'));
}

/** 在内存远端放一个设备的一条记录(索引里直接带块清单)。 */
async function seedRemote(
  remote: MemoryRemote,
  body: string,
  over: { generation?: string; deviceId?: string; relPath?: string; harness?: string } = {},
) {
  const deviceId = over.deviceId ?? 'devA';
  const harness = over.harness ?? 'claude-code';
  const relPath = over.relPath ?? 'projects/a.jsonl';
  const generation = over.generation ?? 'g1';
  const key = encodeKey(relPath);
  const chunks: ChunkRef[] = [...body.matchAll(/.{1,4}/gs)].map((m, i) => ({
    offset: i * CH,
    length: Buffer.byteLength(m[0]),
    sha256: createHash('sha256')
      .update(Buffer.from(body, 'utf8').subarray(i * CH, i * CH + Buffer.byteLength(m[0])))
      .digest('hex'),
  }));
  for (const c of chunks) {
    remote.files.set(
      chunkRemotePath(deviceId, harness, key, generation, c),
      Buffer.from(body, 'utf8').subarray(c.offset, c.offset + c.length),
    );
  }
  const item: IndexItem = {
    harness,
    key,
    relPath,
    sessionKey: relPath,
    generation,
    size: Buffer.byteLength(body),
    chunks,
    chunksHash: chunksHash(chunks),
    updatedAt: 1,
  };
  const index: DeviceIndex = {
    v: 1,
    deviceId,
    updatedAt: 1,
    items: { [itemKey(harness, key)]: item },
  };
  await remote.writeJson(indexPath(deviceId), index);
  remote.writes.length = 0;
  remote.reads.length = 0;
  return { deviceId, harness, key, item };
}

const opts = (root: string, remote: MemoryRemote, deviceId = 'devSelf') => ({
  remote,
  deviceId,
  vaultRoot: root,
  state: emptyState(),
  chunkSize: CH,
});

describe('pullRemote(重建 + 增量)', () => {
  it('首次拉取:按块重建,字节完全一致', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { deviceId, harness } = await seedRemote(remote, '0123456789');

    const r = await pullRemote(opts(root, remote));

    expect(r.downloadedChunks).toBe(3);
    expect(r.downloadedItems).toBe(1);
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    expect(await readFile(local, 'utf8')).toBe('0123456789');
    expect(remote.reads.filter((p) => p.endsWith('.bin'))).toHaveLength(3);
  });

  it('重复拉取(索引未变)→ 不再请求任何块', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    await seedRemote(remote, '0123456789');
    const o = opts(root, remote);
    await pullRemote(o);
    remote.reads.length = 0;
    remote.writes.length = 0;

    const r = await pullRemote(o);
    expect(r.downloadedChunks).toBe(0);
    expect(r.skippedItems).toBe(1);
    expect(remote.reads).toEqual([]);
  });

  it('同世代追加 → 只下载新块,本地保留已有前缀', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    await seedRemote(remote, '0123456789');
    const o = opts(root, remote);
    await pullRemote(o);
    remote.reads.length = 0;

    const { deviceId, harness } = await seedRemote(remote, '0123456789WXYZ');

    const r = await pullRemote(o);
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    expect(await readFile(local, 'utf8')).toBe('0123456789WXYZ');
    expect(r.downloadedChunks).toBe(2); // 已有 0-8,只取 8-4 与 12-2
    const chunkReads = remote.reads.filter((p) => p.endsWith('.bin'));
    expect(chunkReads.map((p) => p.match(/-(\d+)\.bin$/)![1])).toEqual(['4', '2']);
  });

  it('块哈希不符 → 抛错,本地已有文件不被破坏', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { deviceId, harness, key, item } = await seedRemote(remote, '0123456789');
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, '0123456789');
    const o = opts(root, remote);
    o.state.pulled[deviceId] = {
      [itemKey(harness, key)]: { generation: 'old', size: 4, chunksHash: 'x' },
    };
    const bad = chunkRemotePath(deviceId, harness, key, item.generation, item.chunks[0]!);
    remote.files.set(bad, Buffer.from('XXXX'));

    await expect(pullRemote(o)).rejects.toThrow(/校验失败/);
    expect(await readFile(local, 'utf8')).toBe('0123456789');
  });

  it('本机设备:本地比远端新 → 不覆盖本地', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { deviceId, harness, key } = await seedRemote(remote, 'short');
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, 'local-is-longer');
    const o = opts(root, remote, deviceId);

    const r = await pullRemote(o);

    expect(r.downloadedItems).toBe(0);
    expect(await readFile(local, 'utf8')).toBe('local-is-longer');
    // 本机本地更大:标记为已同步,避免下一轮再检查
    expect(o.state.pulled[deviceId]?.[itemKey(harness, key)]).toBeDefined();
  });

  it('本机设备:世代不一致且本地更小 → 也不回拉覆盖', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { deviceId, harness } = await seedRemote(remote, 'remote-longer', { generation: 'g2' });
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, 'local');
    const o = opts(root, remote, deviceId);

    const r = await pullRemote(o);

    expect(r.downloadedItems).toBe(0);
    expect(await readFile(local, 'utf8')).toBe('local');
  });

  it('本机设备:本地同尺寸 → 不重复下载,直接记账', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { deviceId, harness, key } = await seedRemote(remote, '0123456789');
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, '0123456789');
    const o = opts(root, remote, deviceId);

    const r = await pullRemote(o);

    expect(r.downloadedItems).toBe(0);
    expect(remote.reads).toEqual([]);
    expect(o.state.pulled[deviceId]?.[itemKey(harness, key)]).toBeDefined();
  });

  it('远端索引里的路径穿越被拒绝', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const key = Buffer.from('../escape').toString('base64url');
    await remote.writeJson(indexPath('devA'), {
      v: 1,
      deviceId: 'devA',
      updatedAt: 1,
      items: {
        'claude-code:AAAA': {
          harness: 'claude-code',
          key,
          relPath: '../escape',
          sessionKey: 'x',
          generation: 'g1',
          size: 0,
          chunks: [],
          chunksHash: chunksHash([]),
          updatedAt: 1,
        },
      },
    });
    await expect(pullRemote(opts(root, remote))).rejects.toThrow(/非法路径/);
  });

  it('续传起点按清单真实块边界对齐(兼容不同块大小的旧清单)', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const body = '0123456789'; // 10 bytes
    const { deviceId, harness, key } = await seedRemote(remote, body);
    const item = Object.values(
      ((await remote.readJson(indexPath(deviceId))) as DeviceIndex).items,
    )[0]!;
    // 人为改成 8+2 两块(模拟旧版本 8MB 块),本地只有前 4 字节
    const big = [
      { offset: 0, length: 8, sha256: createHash('sha256').update(Buffer.from('01234567')).digest('hex') },
      { offset: 8, length: 2, sha256: createHash('sha256').update(Buffer.from('89')).digest('hex') },
    ];
    const manifestItem = { ...item, chunks: big, chunksHash: chunksHash(big) };
    await remote.writeJson(indexPath(deviceId), {
      v: 1, deviceId, updatedAt: 1, items: { [itemKey(harness, key)]: manifestItem },
    });
    remote.files.set(chunkRemotePath(deviceId, harness, key, item.generation, big[0]!), Buffer.from('01234567'));
    remote.files.set(chunkRemotePath(deviceId, harness, key, item.generation, big[1]!), Buffer.from('89'));
    const local = join(root, 'raw', deviceId, harness, 'projects', 'a.jsonl');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, '0123');
    const o = opts(root, remote);
    o.state.pulled[deviceId] = {
      [itemKey(harness, key)]: { generation: item.generation, size: 10, chunksHash: chunksHash([]) },
    };

    const r = await pullRemote(o);

    expect(r.downloadedChunks).toBe(2); // 起点回到块 0,避免漏掉 4-8 字节
    expect(await readFile(local, 'utf8')).toBe(body);
  });

  it('索引里的块清单与 chunksHash 不符 → 拒绝', async () => {
    const root = await vault();
    const remote = new MemoryRemote();
    const { item, deviceId } = await seedRemote(remote, 'abcd');
    await remote.writeJson(indexPath(deviceId), {
      v: 1,
      deviceId,
      updatedAt: 1,
      items: { [itemKey(item.harness, item.key)]: { ...item, chunksHash: '0'.repeat(64) } },
    });
    await expect(pullRemote(opts(root, remote))).rejects.toThrow(/块哈希不一致/);
  });
});

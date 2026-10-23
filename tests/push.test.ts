import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pushLocal } from '../src/core/push.js';
import { emptyState, type State } from '../src/core/state.js';
import { chunkRemotePath, indexPath, type DeviceIndex } from '../src/core/remote-layout.js';
import { MemoryRemote } from './helpers/memory-remote.js';

async function vault() {
  return mkdtemp(join(tmpdir(), 'trove-push-'));
}

async function seed(
  root: string,
  relPath: string,
  body: string,
  over: Partial<State['sources'][string][string]> = {},
): Promise<State> {
  const p = join(root, 'raw', 'dev1', 'claude-code', ...relPath.split('/'));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
  const state = emptyState();
  state.sources['claude-code'] = {
    [relPath]: {
      size: Buffer.byteLength(body),
      mtimeMs: 1000,
      prefixHash: 'h',
      generation: 'g1',
      sessionKey: relPath,
      sessionMtimeMs: 1000,
      ...over,
    },
  };
  return state;
}

const opts = (root: string, state: State, remote: MemoryRemote, chunkSize = 4) => ({
  remote,
  deviceId: 'dev1',
  deviceName: '本机',
  vaultRoot: root,
  state,
  chunkSize,
  now: () => 12345,
});

async function indexOf(remote: MemoryRemote): Promise<DeviceIndex> {
  return (await remote.readJson(indexPath('dev1'))) as DeviceIndex;
}

describe('pushLocal(块级增量推送,索引即清单)', () => {
  it('首次推送:上传块 + 单份索引,远端字节与本地一致', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', '0123456789');
    const remote = new MemoryRemote();

    const r = await pushLocal(opts(root, state, remote));

    expect(r.uploadedChunks).toBe(3); // 4+4+2
    expect(r.uploadedBytes).toBe(10);
    const index = await indexOf(remote);
    const item = Object.values(index.items)[0]!;
    expect(item).toMatchObject({ harness: 'claude-code', size: 10, generation: 'g1' });
    expect(item.relPath).toBe('projects/a.jsonl');
    expect(item.chunks.map((c) => c.length)).toEqual([4, 4, 2]);
    for (const c of item.chunks) {
      const bytes = remote.files.get(chunkRemotePath('dev1', 'claude-code', item.key, 'g1', c))!;
      expect(bytes.toString()).toBe('0123456789'.slice(c.offset, c.offset + c.length));
    }
    expect(state.pushed['claude-code']!['projects/a.jsonl']!.size).toBe(10);
  });

  it('重复推送(无变化)→ 不再上传任何东西', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', '0123456789');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));
    const before = remote.writes.length;

    const r = await pushLocal(opts(root, state, remote));

    expect(r.uploadedChunks).toBe(0);
    expect(remote.writes.length).toBe(before);
  });

  it('追加增长 → 只上传新块,旧块复用', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', '0123456789');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));

    const p = join(root, 'raw', 'dev1', 'claude-code', 'projects', 'a.jsonl');
    await writeFile(p, '0123456789WXYZ');
    const entry = state.sources['claude-code']!['projects/a.jsonl']!;
    entry.size = 14;
    entry.mtimeMs = 2000;

    const before = remote.writes.filter((w) => w.endsWith('.bin')).length;
    const r = await pushLocal(opts(root, state, remote));
    const added = remote.writes.filter((w) => w.endsWith('.bin')).length - before;

    expect(r.uploadedChunks).toBe(2); // 8-12 由半块变整块需重传,另加 12-14
    expect(added).toBe(2);
    const item = Object.values((await indexOf(remote)).items)[0]!;
    expect(item.size).toBe(14);
    expect(item.chunks.map((c) => c.offset)).toEqual([0, 4, 8, 12]);
  });

  it('世代重置 → 新世代块,旧世代块保留(永不删除)', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', 'aaaaaaaa');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));

    const p = join(root, 'raw', 'dev1', 'claude-code', 'projects', 'a.jsonl');
    await writeFile(p, 'bbbbbbbb');
    const entry = state.sources['claude-code']!['projects/a.jsonl']!;
    entry.generation = 'g2';
    entry.prefixHash = 'h2';

    const r = await pushLocal(opts(root, state, remote));
    expect(r.uploadedChunks).toBe(2);
    const keys = [...remote.files.keys()];
    expect(keys.some((k) => k.includes('.g1.'))).toBe(true);
    expect(keys.some((k) => k.includes('.g2.'))).toBe(true);
  });

  it('空文件也提交索引项(远端可见,内容为空)', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/empty.jsonl', '');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));
    const item = Object.values((await indexOf(remote)).items)[0]!;
    expect(item.chunks).toEqual([]);
    expect(item.size).toBe(0);
  });

  it('路径穿越的源状态被拒绝', async () => {
    const root = await vault();
    const state = emptyState();
    state.sources['claude-code'] = {
      '../evil': {
        size: 1,
        mtimeMs: 1,
        prefixHash: 'h',
        generation: 'g1',
        sessionKey: '../evil',
        sessionMtimeMs: 1,
      },
    };
    await expect(pushLocal(opts(root, state, new MemoryRemote()))).rejects.toThrow(/非法路径/);
  });

  it('本地推送状态丢失但索引完好 → 零重传,并从索引恢复状态', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', '0123456789');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));
    const before = remote.writes.length;
    delete state.pushed['claude-code'];

    const r = await pushLocal(opts(root, state, remote));

    expect(r.uploadedChunks).toBe(0);
    expect(remote.writes.length).toBe(before);
    expect(state.pushed['claude-code']!['projects/a.jsonl']!.chunksHash).toBe(
      Object.values((await indexOf(remote)).items)[0]!.chunksHash,
    );
  });

  it('索引丢失 → 块仍在远端时只补半块并重建索引', async () => {
    const root = await vault();
    const state = await seed(root, 'projects/a.jsonl', '0123456789');
    const remote = new MemoryRemote();
    await pushLocal(opts(root, state, remote));
    await remote.delete(indexPath('dev1'));

    const r = await pushLocal(opts(root, state, remote));

    expect(r.uploadedChunks).toBe(1); // 0-4/4-4 完整块复用,8-10 半块重传
    const item = Object.values((await indexOf(remote)).items)[0]!;
    expect(item.size).toBe(10);
  });
});

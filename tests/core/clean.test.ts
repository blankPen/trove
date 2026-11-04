import { describe, it, expect } from 'vitest';
import { deleteOrphans, scanOrphans } from '../../src/core/clean.js';
import {
  chunkRemotePath,
  chunksHash,
  encodeKey,
  indexPath,
  objectRemotePath,
  type DeviceIndex,
  type IndexItem,
} from '../../src/core/remote-layout.js';
import { MemoryRemote } from '../helpers/memory-remote.js';

/** 固定「当前时间」与一个早于 24h 阈值的时间。 */
const NOW = 10 * 24 * 3600 * 1000;
const OLD = NOW - 48 * 3600 * 1000;
const now = () => NOW;

function put(remote: MemoryRemote, path: string, body = 'x', mtime = OLD): void {
  remote.files.set(path, Buffer.from(body));
  remote.mtimes.set(path, mtime);
}

function chunkItem(over: Partial<IndexItem> = {}): IndexItem {
  const relPath = over.relPath ?? 'projects/a.jsonl';
  const key = over.key ?? encodeKey(relPath);
  const chunk = { offset: 0, length: 4, sha256: 'a'.repeat(64) };
  return {
    harness: 'claude-code',
    key,
    relPath,
    sessionKey: relPath,
    generation: 'g1',
    size: 4,
    chunks: [chunk],
    chunksHash: chunksHash([chunk]),
    updatedAt: 1,
    ...over,
  };
}

async function indexRemote(items: IndexItem[], device = 'dev1'): Promise<MemoryRemote> {
  const remote = new MemoryRemote();
  const index: DeviceIndex = {
    v: 1,
    deviceId: device,
    updatedAt: 1,
    items: Object.fromEntries(items.map((i) => [`${i.harness}:${i.key}`, i])),
  };
  await remote.writeJson(indexPath(device), index);
  return remote;
}

describe('scanOrphans raw', () => {
  it('未被索引引用的旧世代 chunk 是孤儿,被引用的保留', async () => {
    const item = chunkItem();
    const remote = await indexRemote([item]);
    const chunk = item.chunks[0]!;
    const kept = chunkRemotePath('dev1', item.harness, item.key, item.generation, chunk);
    const orphan = chunkRemotePath('dev1', item.harness, item.key, 'old-gen', chunk);
    put(remote, kept);
    put(remote, orphan);

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects.map((o) => o.path)).toEqual([orphan]);
    expect(scan.objects[0]!.category).toBe('raw-chunk');
  });

  it('object 布局按 relPath 保留,空文件对象也保留', async () => {
    const nonEmpty = chunkItem({
      relPath: 'projects/a.jsonl',
      layout: 'object',
      size: 4,
      chunks: [{ offset: 0, length: 4, sha256: 'b'.repeat(64) }],
    });
    const empty = chunkItem({
      relPath: 'projects/empty.jsonl',
      key: encodeKey('projects/empty.jsonl'),
      layout: 'object',
      size: 0,
      chunks: [],
      chunksHash: chunksHash([]),
    });
    const remote = await indexRemote([nonEmpty, empty]);
    const keptA = objectRemotePath('dev1', 'claude-code', nonEmpty.relPath);
    const keptEmpty = objectRemotePath('dev1', 'claude-code', empty.relPath);
    const orphan = objectRemotePath('dev1', 'claude-code', 'projects/old.jsonl');
    put(remote, keptA);
    put(remote, keptEmpty, '');
    put(remote, orphan);

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects.map((o) => o.path)).toEqual([orphan]);
    expect(scan.objects[0]!.category).toBe('raw-file');
  });

  it('新对象不受年龄阈值影响', async () => {
    const remote = await indexRemote([]);
    const orphan = objectRemotePath('dev1', 'claude-code', 'projects/new.jsonl');
    put(remote, orphan, 'x', NOW - 1000); // 刚上传

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects).toEqual([]);
  });

  it('设备索引缺失时整个设备跳过', async () => {
    const remote = new MemoryRemote();
    put(remote, chunkRemotePath('dev9', 'claude-code', 'K', 'g1', { offset: 0, length: 4 }));

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects).toEqual([]);
    expect(scan.skippedDevices).toEqual(['dev9']);
  });
});

describe('scanOrphans library', () => {
  function shard(device = 'dev1') {
    return {
      v: 1,
      device,
      mapper: 'events@1',
      updatedAt: '2026-11-01T00:00:00.000Z',
      sessions: {
        'claude-code:s1': {
          device,
          path: `sessions/claude-code/s1/${device}.jsonl`,
          hash: 'h',
          events: 1,
          rawSources: [],
        },
      },
      skills: {},
    };
  }

  it('分片引用的会话与 merged 文件保留,未引用的删除;lessons 不扫描', async () => {
    const remote = new MemoryRemote();
    await remote.writeJson('library/index/dev1.json', shard('dev1'));
    const kept = 'library/sessions/claude-code/s1/dev1.jsonl';
    const merged = 'library/sessions/claude-code/s1/merged.abcd1234.jsonl';
    const orphan = 'library/sessions/claude-code/s2/dev1.jsonl';
    put(remote, kept);
    put(remote, merged);
    put(remote, orphan);
    put(remote, 'library/lessons/preferences/style.md');

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects.map((o) => o.path)).toEqual([orphan]);
    expect(scan.objects[0]!.category).toBe('library-session');
  });

  it('技能的 meta 保留,versions 只保留被版本 hash 引用的目录', async () => {
    const remote = new MemoryRemote();
    await remote.writeJson('library/index/dev1.json', shard('dev1'));
    const meta = 'library/skills/review/meta/dev1.json';
    const kept = 'library/skills/review/versions/h1/SKILL.md';
    const orphan = 'library/skills/review/versions/h2/SKILL.md';
    put(remote, meta, JSON.stringify({ versions: [{ hash: 'h1' }] }));
    put(remote, kept);
    put(remote, orphan);

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects.map((o) => o.path)).toEqual([orphan]);
    expect(scan.objects[0]!.category).toBe('library-skill');
  });

  it('技能没有 meta 时整个目录保留', async () => {
    const remote = new MemoryRemote();
    await remote.writeJson('library/index/dev1.json', shard('dev1'));
    const file = 'library/skills/review/versions/h9/SKILL.md';
    put(remote, file);

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects).toEqual([]);
    expect(scan.skippedSkills).toContain('review');
  });

  it('任一分片读取失败 → 跳过整个 library 清理', async () => {
    const remote = new MemoryRemote();
    put(remote, 'library/index/dev1.json', 'not-json');
    const orphan = 'library/sessions/claude-code/s2/dev1.jsonl';
    put(remote, orphan);

    const scan = await scanOrphans(remote, { now });

    expect(scan.librarySkipped).toBe(true);
    expect(scan.objects).toEqual([]);
  });

  it('忽略 WebDAV 原子写的临时文件', async () => {
    const remote = new MemoryRemote();
    await remote.writeJson('library/index/dev1.json', shard('dev1'));
    put(remote, 'library/sessions/claude-code/s2/dev1.jsonl.tmp-123');

    const scan = await scanOrphans(remote, { now });

    expect(scan.objects).toEqual([]);
  });
});

describe('deleteOrphans', () => {
  it('删除扫描结果并统计数量/大小,失败不中断', async () => {
    const remote = await indexRemote([]);
    const a = objectRemotePath('dev1', 'claude-code', 'a.jsonl');
    const b = objectRemotePath('dev1', 'claude-code', 'b.jsonl');
    put(remote, a, '1234');
    put(remote, b, '123456');
    const scan = await scanOrphans(remote, { now });

    const r = await deleteOrphans(remote, scan);

    expect(r.deleted).toBe(2);
    expect(r.bytes).toBe(10);
    expect(remote.files.has(a)).toBe(false);
    expect(remote.files.has(b)).toBe(false);
  });
});

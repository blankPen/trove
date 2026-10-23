import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pushLibrary } from '../src/core/library/sync.js';
import { emptyState, loadState } from '../src/core/state.js';
import { MemoryRemote } from './helpers/memory-remote.js';

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'trove-libpush-'));
  const rels = [
    'index/dev1.json',
    'sessions/claude-code/s1/dev1.jsonl',
    'sessions/claude-code/s2/dev1.jsonl',
    'skills/review/versions/abc/SKILL.md',
  ];
  for (const rel of rels) {
    const abs = join(vault, 'library', ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `x:${rel}`);
  }
  return { vault, rels, statePath: join(vault, 'state.json') };
}

describe('pushLibrary 断点续传', () => {
  it('中断时把已完成文件落盘,重启只推剩余文件', async () => {
    const { vault, rels, statePath } = await fixture();
    const state = emptyState();
    const controller = new AbortController();
    const remote = new MemoryRemote();
    const original = remote.writeFile.bind(remote);
    let writes = 0;
    remote.writeFile = async (path, localPath, range) => {
      await original(path, localPath, range);
      if (++writes === 1) controller.abort(); // 传完第一个文件就中断
    };

    await expect(
      pushLibrary({
        remote,
        vaultRoot: vault,
        deviceId: 'dev1',
        state,
        statePath,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // 已完成的那一个文件必须已经落盘
    const saved = await loadState(statePath);
    const done = Object.keys(saved.library.pushed);
    expect(done).toHaveLength(1);
    expect(remote.count('library/')).toBe(1);

    // 重启:跳过已推文件,只传剩余 3 个
    const remote2 = new MemoryRemote();
    const resumed = await pushLibrary({
      remote: remote2,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: saved,
      statePath,
    });
    expect(resumed).toMatchObject({ uploaded: rels.length - 1, skipped: 1 });
    expect(remote2.writes).not.toContain(done[0]);

    // 再跑一次:零上传
    const again = await pushLibrary({
      remote: remote2,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: saved,
      statePath,
    });
    expect(again.uploaded).toBe(0);
    expect(again.skipped).toBe(rels.length);
  });

  it('index 分片最后上传(提交点)', async () => {
    const { vault, statePath } = await fixture();
    const remote = new MemoryRemote();

    await pushLibrary({
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: emptyState(),
      statePath,
    });

    expect(remote.writes.at(-1)).toMatch(/^library\/index\//);
  });
});

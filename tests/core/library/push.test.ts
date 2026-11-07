import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pushLibrary } from '../../../src/core/library/sync.js';
import { emptyState, loadState } from '../../../src/core/state.js';
import { LESSONS_STAMP_PATH, libraryStampPath } from '../../../src/core/remote-layout.js';
import { MemoryRemote } from '../../helpers/memory-remote.js';

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'trove-libpush-'));
  const rels = [
    'index/dev1.json',
    'sessions/claude-code/s1/dev1.jsonl',
    'sessions/claude-code/s2/dev1.jsonl',
    'skills/review/versions/abc/SKILL.md',
    'lessons/preferences/style.md',
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

    expect(remote.writes.filter((w) => !w.endsWith('.stamp')).at(-1)).toMatch(/^library\/index\//);
  });

  it('推送后写入分片戳与 lessons 戳,重复推送不再重写', async () => {
    const { vault, statePath } = await fixture();
    const remote = new MemoryRemote();
    const opts = {
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: emptyState(),
      statePath,
    };

    await pushLibrary(opts);

    expect(await remote.readJson(libraryStampPath('dev1'))).toMatchObject({ v: 1 });
    expect(await remote.readJson(LESSONS_STAMP_PATH)).toMatchObject({ v: 1 });
    const stamps = remote.writes.filter((w) => w.endsWith('.stamp')).length;

    await pushLibrary(opts);

    expect(remote.writes.filter((w) => w.endsWith('.stamp')).length).toBe(stamps);
  });

  it('换后端(remoteId 变了) → 忽略旧水位,整份重推', async () => {
    const { vault, rels, statePath } = await fixture();
    const state = emptyState();
    const oldRemote = new MemoryRemote();
    await pushLibrary({
      remote: oldRemote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state,
      remoteId: 'webdav:http://old.example/',
      statePath,
    });
    expect(state.library.remoteId).toBe('webdav:http://old.example/');

    // 新后端是空桶:旧的 pushed 记账不能让它跳过上传
    const newRemote = new MemoryRemote();
    const r = await pushLibrary({
      remote: newRemote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state,
      remoteId: 's3:https://cos.example/bucket',
      statePath,
    });

    expect(r.uploaded).toBe(rels.length);
    expect(r.skipped).toBe(0);
    expect(newRemote.writes.filter((w) => !w.endsWith('.stamp'))).toHaveLength(rels.length);
    expect(state.library.remoteId).toBe('s3:https://cos.example/bucket');
  });

  it('同一后端重复推送 → 零上传', async () => {
    const { vault, statePath } = await fixture();
    const state = emptyState();
    const remote = new MemoryRemote();
    const opts = {
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state,
      remoteId: 's3:https://cos.example/bucket',
      statePath,
    };
    await pushLibrary(opts);
    const before = remote.writes.length;

    const r = await pushLibrary(opts);

    expect(r.uploaded).toBe(0);
    expect(remote.writes.length).toBe(before);
  });

  it('老 state 有 pushed 记录但没有 library.remoteId → 整份重推', async () => {
    const { vault, rels, statePath } = await fixture();
    const state = emptyState();
    // 模拟升级前的 state:文件都记过账,但没有远端身份
    for (const rel of rels) {
      state.library.pushed[rel] = { size: 1, mtimeMs: 1 };
    }
    const remote = new MemoryRemote();

    const r = await pushLibrary({
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state,
      remoteId: 's3:https://cos.example/bucket',
      statePath,
    });

    expect(r.uploaded).toBe(rels.length);
    expect(r.skipped).toBe(0);
  });

  it('换后端中途中断 → 新远端身份已落盘,重启只补剩余', async () => {
    const { vault, rels, statePath } = await fixture();
    const state = emptyState();
    // 旧后端留下的记账
    for (const rel of rels) state.library.pushed[rel] = { size: 1, mtimeMs: 1 };
    state.library.remoteId = 'webdav:http://old.example/';

    const remote = new MemoryRemote();
    const original = remote.writeFile.bind(remote);
    let writes = 0;
    remote.writeFile = async (path, localPath, range) => {
      await original(path, localPath, range);
      if (++writes === 2) throw new Error('interrupted'); // 第二个文件后进程被打断
    };

    await expect(
      pushLibrary({
        remote,
        vaultRoot: vault,
        deviceId: 'dev1',
        state,
        remoteId: 's3:https://cos.example/bucket',
        statePath,
      }),
    ).rejects.toThrow('interrupted');

    // 关键:新远端身份与已完成记录必须已经落盘
    const saved = await loadState(statePath);
    expect(saved.library.remoteId).toBe('s3:https://cos.example/bucket');
    expect(Object.keys(saved.library.pushed)).toHaveLength(1);

    // 重启(同一个远端):跳过已推的 1 个,只补剩余
    const r = await pushLibrary({
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: saved,
      remoteId: 's3:https://cos.example/bucket',
      statePath,
    });

    expect(r.uploaded).toBe(rels.length - 1);
    expect(r.skipped).toBe(1);
  });
});

describe('pushLibrary 设备归属', () => {
  it('只推本设备的会话文件与分片,不回传他设备/merged 产物', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpush-own-'));
    const files = [
      'sessions/claude-code/s1/dev1.jsonl',
      'sessions/claude-code/s1/dev2.jsonl',
      'sessions/claude-code/s1/merged.abcd1234.jsonl',
      'index/dev1.json',
      'index/dev2.json',
      'skills/review/versions/h/SKILL.md',
      'lessons/preferences/style.md',
    ];
    for (const rel of files) {
      const abs = join(vault, 'library', ...rel.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, `x:${rel}`);
    }
    const remote = new MemoryRemote();

    await pushLibrary({
      remote,
      vaultRoot: vault,
      deviceId: 'dev1',
      state: emptyState(),
      statePath: join(vault, 'state.json'),
    });

    expect(remote.writes).toContain('library/sessions/claude-code/s1/dev1.jsonl');
    expect(remote.writes).toContain('library/index/dev1.json');
    expect(remote.writes).toContain('library/skills/review/versions/h/SKILL.md');
    expect(remote.writes).toContain('library/lessons/preferences/style.md');
    expect(remote.writes).not.toContain('library/sessions/claude-code/s1/dev2.jsonl');
    expect(remote.writes).not.toContain('library/sessions/claude-code/s1/merged.abcd1234.jsonl');
    expect(remote.writes).not.toContain('library/index/dev2.json');
  });
});

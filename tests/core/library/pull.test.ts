import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { pullLibrary } from '../../../src/core/library/sync.js';
import { emptyState } from '../../../src/core/state.js';
import {
  LESSONS_STAMP_PATH,
  libraryStampPath,
} from '../../../src/core/remote-layout.js';
import type { IndexShard } from '../../../src/core/library/schema.js';
import { MemoryRemote } from '../../helpers/memory-remote.js';

const REL = 'sessions/claude-code/s1/dev1.jsonl';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setup(localBody: string | null) {
  const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-'));
  const abs = join(vault, 'library', ...REL.split('/'));
  if (localBody !== null) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, localBody);
  }
  const remote = new MemoryRemote();
  remote.files.set(`library/${REL}`, Buffer.from('remote'));
  const shard: IndexShard = {
    v: 1,
    device: 'dev1',
    mapper: 'claude-code',
    updatedAt: '2026-10-23T00:00:00.000Z',
    sessions: {
      'claude-code:s1': {
        device: 'dev1',
        path: REL,
        hash: sha('remote'),
        events: 1,
        rawSources: [],
      },
    },
    skills: {},
  };
  await remote.writeJson('library/index/dev1.json', shard);
  return { vault, abs, remote };
}

describe('pullLibrary 本机文件权威', () => {
  it('本机文件存在时不拿远端旧分片覆盖', async () => {
    const { vault, abs, remote } = await setup('newer');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('newer');
  });

  it('本机文件缺失时从远端恢复', async () => {
    const { vault, abs, remote } = await setup(null);

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('remote');
  });

  it('其他设备的同名会话仍按 hash 拉取', async () => {
    const { vault, abs, remote } = await setup('newer');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    // dev2 视角下这是远端变体,本地同名文件不一致 → 以分片为准
    expect(await readFile(abs, 'utf8')).toBe('remote');
  });
});

describe('pullLibrary 分片本机权威', () => {
  const shardAbs = (vault: string) => join(vault, 'library', 'index', 'dev1.json');
  const NEW = '{"v":1,"device":"dev1","updatedAt":"2026-10-29T00:00:00.000Z","sessions":{}}\n';

  it('本机分片已存在时不拿远端同名旧分片覆盖', async () => {
    const { vault, remote } = await setup('newer');
    await mkdir(dirname(shardAbs(vault)), { recursive: true });
    await writeFile(shardAbs(vault), NEW);

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    const got = JSON.parse(await readFile(shardAbs(vault), 'utf8')) as IndexShard;
    expect(got.updatedAt).toBe('2026-10-29T00:00:00.000Z');
  });

  it('本机分片缺失时仍从远端恢复', async () => {
    const { vault, remote } = await setup('newer');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    const got = JSON.parse(await readFile(shardAbs(vault), 'utf8')) as IndexShard;
    expect(got.updatedAt).toBe('2026-10-23T00:00:00.000Z');
  });

  it('其他设备的分片仍照常覆盖', async () => {
    const { vault, remote } = await setup('newer');
    await mkdir(dirname(shardAbs(vault)), { recursive: true });
    await writeFile(shardAbs(vault), NEW);

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    const got = JSON.parse(await readFile(shardAbs(vault), 'utf8')) as IndexShard;
    expect(got.updatedAt).toBe('2026-10-23T00:00:00.000Z');
  });
});

describe('pullLibrary 变更戳', () => {
  it('分片戳未变且本地文件齐全 → 不读整份分片', async () => {
    const { vault, remote } = await setup('newer');
    const state = emptyState();
    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state });

    const size = (await remote.list('library/index')).find((e) => e.name === 'dev1.json')!.size;
    await remote.writeJson(libraryStampPath('dev1'), { v: 1, hash: 'h1', size, updatedAt: 1 });
    state.library.shardStamps = { dev1: 'h1' };
    const spy = vi.spyOn(remote, 'readJson');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state });

    expect(spy.mock.calls.map((c) => c[0])).not.toContain('library/index/dev1.json');
  });

  it('本机分片与文件齐全 → 不读远端同名分片', async () => {
    const { vault, remote } = await setup('newer');
    const state = emptyState();
    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state });
    const spy = vi.spyOn(remote, 'readJson');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state });

    expect(spy.mock.calls.map((c) => c[0])).not.toContain('library/index/dev1.json');
  });

  it('本机分片存在但引用的会话缺失 → 仍从远端恢复', async () => {
    const { vault, abs, remote } = await setup(null);
    const shardAbs = join(vault, 'library', 'index', 'dev1.json');
    await mkdir(dirname(shardAbs), { recursive: true });
    await writeFile(
      shardAbs,
      JSON.stringify({
        v: 1,
        device: 'dev1',
        mapper: 'claude-code',
        updatedAt: '2026-10-23T00:00:00.000Z',
        sessions: {
          'claude-code:s1': { device: 'dev1', path: REL, hash: sha('remote'), events: 1, rawSources: [] },
        },
        skills: {},
      }),
    );

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('remote');
  });
});

describe('pullLibrary 技能 meta/版本拉取', () => {
  async function skillSetup(metaVersion: string) {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-skill-'));
    const remote = new MemoryRemote();
    const shard: IndexShard = {
      v: 1,
      device: 'dev1',
      mapper: 'claude-code',
      updatedAt: '2026-10-23T00:00:00.000Z',
      sessions: {},
      skills: {
        review: { name: 'review', hash: 'h', source: 'self', files: [] },
      },
    };
    await remote.writeJson('library/index/dev1.json', shard);
    remote.files.set(
      'library/skills/review/meta/every.json',
      Buffer.from(JSON.stringify({ versions: [{ hash: metaVersion, files: [{ rel: 'SKILL.md' }] }] })),
    );
    remote.files.set(
      `library/skills/review/versions/${metaVersion}/SKILL.md`,
      Buffer.from('review-body'),
    );
    return { vault, remote };
  }

  it('按 shard.skills 拉取 meta 与版本文件', async () => {
    const { vault, remote } = await skillSetup('v1');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    const body = await readFile(
      join(vault, 'library', 'skills', 'review', 'versions', 'v1', 'SKILL.md'),
      'utf8',
    );
    expect(body).toBe('review-body');
    const meta = JSON.parse(
      await readFile(join(vault, 'library', 'skills', 'review', 'meta', 'every.json'), 'utf8'),
    ) as { versions: Array<{ hash: string }> };
    expect(meta.versions[0]!.hash).toBe('v1');
  });
});

describe('pullLibrary lessons 恢复', () => {
  const LESSON = 'library/lessons/preferences/style.md';

  async function lessonsSetup(localBody: string | null) {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-lesson-'));
    const abs = join(vault, 'library', 'lessons', 'preferences', 'style.md');
    if (localBody !== null) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, localBody);
    }
    const remote = new MemoryRemote();
    remote.files.set(LESSON, Buffer.from('remote-lesson'));
    return { vault, abs, remote };
  }

  it('本地缺失时从远端恢复', async () => {
    const { vault, abs, remote } = await lessonsSetup(null);

    const r = await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('remote-lesson');
    expect(r.downloaded).toBe(1);
  });

  it('本地已有内容时不覆盖(本机可能刚 learn 完)', async () => {
    const { vault, abs, remote } = await lessonsSetup('local-newer');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('local-newer');
  });

  it('lessons 戳未变 → 不列举远端目录', async () => {
    const { vault, remote } = await lessonsSetup('local-newer');
    await remote.writeJson(LESSONS_STAMP_PATH, { v: 1, token: 't1', updatedAt: 1 });
    const state = emptyState();
    state.library.lessonsToken = 't1';
    const spy = vi.spyOn(remote, 'listAll');

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state });

    expect(spy).not.toHaveBeenCalled();
  });

  it('listAll 不可用 → 回退逐层列举', async () => {
    const { vault, abs, remote } = await lessonsSetup(null);
    vi.spyOn(remote, 'listAll').mockRejectedValue(new Error('501'));

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(await readFile(abs, 'utf8')).toBe('remote-lesson');
  });
});

describe('pullLibrary 分片悬空容错', () => {
  it('分片引用的会话文件缺失 → 跳过,其余文件正常拉取', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-missing-'));
    const remote = new MemoryRemote();
    const missing = 'sessions/claude-code/00dbb040-e336-4668-bf95-deacd55deb49/dev1.jsonl';
    const shard: IndexShard = {
      v: 1,
      device: 'dev1',
      mapper: 'claude-code',
      updatedAt: '2026-10-23T00:00:00.000Z',
      sessions: {
        'claude-code:missing': {
          device: 'dev1',
          path: missing,
          hash: 'a'.repeat(64),
          events: 1,
          rawSources: [],
        },
        'claude-code:present': {
          device: 'dev1',
          path: REL,
          hash: sha('remote'),
          events: 1,
          rawSources: [],
        },
      },
      skills: {},
    };
    await remote.writeJson('library/index/dev1.json', shard);
    remote.files.set(`library/${REL}`, Buffer.from('remote'));

    const r = await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    expect(r.downloaded).toBe(1);
    expect(
      await readFile(join(vault, 'library', ...REL.split('/')), 'utf8'),
    ).toBe('remote');
    await expect(
      readFile(join(vault, 'library', ...missing.split('/'))),
    ).rejects.toThrow();
  });
});

describe('pullLibrary 下载校验失败容错', () => {
  it('会话文件 hash 不符时跳过并继续,索引不引用缺失条目', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-hash-'));
    const remote = new MemoryRemote();
    const bad = 'sessions/claude-code/bad/dev1.jsonl';
    remote.files.set(`library/${bad}`, Buffer.from('bad-body'));
    remote.files.set(`library/${REL}`, Buffer.from('remote'));
    const shard: IndexShard = {
      v: 1,
      device: 'dev1',
      mapper: 'claude-code',
      updatedAt: '2026-10-23T00:00:00.000Z',
      sessions: {
        'claude-code:bad': {
          device: 'dev1',
          path: bad,
          hash: '0'.repeat(64),
          events: 1,
          rawSources: [],
        },
        'claude-code:s1': {
          device: 'dev1',
          path: REL,
          hash: sha('remote'),
          events: 1,
          rawSources: [],
        },
      },
      skills: {},
    };
    await remote.writeJson('library/index/dev1.json', shard);

    const r = await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    // 坏文件被跳过,好文件照常拉取
    expect(r.downloaded).toBe(1);
    expect(await readFile(join(vault, 'library', ...REL.split('/')), 'utf8')).toBe('remote');
    expect(existsSync(join(vault, 'library', ...bad.split('/')))).toBe(false);
    // 分片在文件之后落盘,并剔除本地缺失的条目
    const local = JSON.parse(
      await readFile(join(vault, 'library', 'index', 'dev1.json'), 'utf8'),
    ) as IndexShard;
    expect(Object.keys(local.sessions)).toEqual(['claude-code:s1']);
    const dir = dirname(join(vault, 'library', ...bad.split('/')));
    expect((await readdir(dir).catch(() => [])).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('拉取中断时不落分片,索引不会引用未下载文件', async () => {
    const { vault, remote } = await setup(null);
    const shardAbs = join(vault, 'library', 'index', 'dev1.json');
    vi.spyOn(remote, 'readFile').mockRejectedValue(new Error('network down'));

    await expect(
      pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() }),
    ).rejects.toThrow('network down');

    expect(existsSync(shardAbs)).toBe(false);
  });
});

describe('pullLibrary 远端路径信任边界', () => {
  it('分片里的穿越路径被跳过,不会写出 vault', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-evil-'));
    const outside = join(tmpdir(), `trove-evil-session-${Date.now()}.jsonl`);
    const remote = new MemoryRemote();
    const evil = `../../${outside.split('/').pop()}`;
    remote.files.set(`library/${evil}`, Buffer.from('evil-remote'));
    const shard: IndexShard = {
      v: 1,
      device: 'dev1',
      mapper: 'claude-code',
      updatedAt: '2026-10-23T00:00:00.000Z',
      sessions: {
        'claude-code:evil': {
          device: 'dev1',
          path: evil,
          hash: sha('evil-remote'),
          events: 1,
          rawSources: [],
        },
      },
      skills: {},
    };
    await remote.writeJson('library/index/dev1.json', shard);

    const r = await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    expect(r.downloaded).toBe(0);
    expect(existsSync(outside)).toBe(false);
    // 分片落盘时剔除非法条目,统一索引不会引用它
    const local = JSON.parse(
      await readFile(join(vault, 'library', 'index', 'dev1.json'), 'utf8'),
    ) as IndexShard;
    expect(local.sessions).toEqual({});
  });

  it('技能版本里的穿越路径被跳过', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-evil-skill-'));
    const outsideName = `trove-evil-skill-${Date.now()}.txt`;
    const outside = join(tmpdir(), outsideName);
    const remote = new MemoryRemote();
    const shard: IndexShard = {
      v: 1,
      device: 'dev1',
      mapper: 'claude-code',
      updatedAt: '2026-10-23T00:00:00.000Z',
      sessions: {},
      skills: { evil: { name: 'evil', hash: 'h', source: 'self', files: [] } },
    };
    await remote.writeJson('library/index/dev1.json', shard);
    remote.files.set(
      'library/skills/evil/meta/every.json',
      Buffer.from(JSON.stringify({ versions: [{ hash: 'v1', files: [{ rel: `../../../../../../${outsideName}` }] }] })),
    );
    remote.files.set(
      `library/skills/evil/versions/v1/../../../../../../${outsideName}`,
      Buffer.from('evil-remote'),
    );

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev2', state: emptyState() });

    expect(existsSync(outside)).toBe(false);
  });

  it('lessons 远端文件名单里的穿越路径被跳过', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-evil-lesson-'));
    const outsideName = `trove-evil-lesson-${Date.now()}.md`;
    const outside = join(tmpdir(), outsideName);
    const remote = new MemoryRemote();
    remote.files.set(`library/lessons/../../../${outsideName}`, Buffer.from('evil-remote'));

    await pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() });

    expect(existsSync(outside)).toBe(false);
  });
});

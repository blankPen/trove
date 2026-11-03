import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pullLibrary } from '../../../src/core/library/sync.js';
import { emptyState } from '../../../src/core/state.js';
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
});

describe('pullLibrary 下载校验失败清理', () => {
  it('会话文件 hash 不符时抛错且不留临时文件', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-libpull-hash-'));
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
          hash: '0'.repeat(64),
          events: 1,
          rawSources: [],
        },
      },
      skills: {},
    };
    await remote.writeJson('library/index/dev1.json', shard);

    await expect(
      pullLibrary({ remote, vaultRoot: vault, deviceId: 'dev1', state: emptyState() }),
    ).rejects.toThrow(/校验失败/);

    const dir = dirname(join(vault, 'library', ...REL.split('/')));
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

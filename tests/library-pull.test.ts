import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pullLibrary } from '../src/core/library/sync.js';
import { emptyState } from '../src/core/state.js';
import type { IndexShard } from '../src/core/library/schema.js';
import { MemoryRemote } from './helpers/memory-remote.js';

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

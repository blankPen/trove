import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from '../../src/cli.js';
import { defaultConfig, saveConfig } from '../../src/config.js';
import { trovePaths } from '../../src/paths.js';
import { chunksHash, encodeKey, indexPath, objectRemotePath } from '../../src/core/remote-layout.js';
import { MemoryRemote } from '../helpers/memory-remote.js';

/** 索引引用一个文件,另放一个未被引用的孤儿对象。 */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-clean-'));
  const paths = trovePaths(base);
  const config = defaultConfig({ deviceId: 'dev1', deviceName: '本机' });
  config.remote = { type: 'webdav', url: 'http://example.invalid', username: 'u', password: 'p' };
  config.sources = {};
  await saveConfig(paths.config, config);

  const remote = new MemoryRemote();
  const relPath = 'projects/a.jsonl';
  const key = encodeKey(relPath);
  const chunk = { offset: 0, length: 4, sha256: 'a'.repeat(64) };
  await remote.writeJson(indexPath('dev1'), {
    v: 1,
    deviceId: 'dev1',
    updatedAt: 1,
    items: {
      [`claude-code:${key}`]: {
        harness: 'claude-code',
        key,
        relPath,
        sessionKey: relPath,
        generation: 'g1',
        size: 4,
        chunks: [chunk],
        chunksHash: chunksHash([chunk]),
        layout: 'object',
        updatedAt: 1,
      },
    },
  });
  const keep = objectRemotePath('dev1', 'claude-code', relPath);
  const orphan = objectRemotePath('dev1', 'claude-code', 'projects/old.jsonl');
  remote.files.set(keep, Buffer.from('keep'));
  remote.files.set(orphan, Buffer.from('old'));
  remote.mtimes.set(keep, 1);
  remote.mtimes.set(orphan, 1);

  const lines: string[] = [];
  const deps = {
    base,
    createRemote: () => remote,
    resolveAdapters: () => [],
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    rawOut: () => {},
    isTTY: false,
    now: () => 10 * 24 * 3600 * 1000,
  };
  return { remote, keep, orphan, lines, deps };
}

describe('trove clean', () => {
  it('默认只列出,不删除', async () => {
    const { remote, orphan, lines, deps } = await setup();

    await run(['clean'], deps);

    expect(remote.files.has(orphan)).toBe(true);
    expect(lines.join('\n')).toContain('待清理对象');
    expect(lines.join('\n')).toContain('--yes');
  });

  it('--dry-run 只列出', async () => {
    const { remote, orphan, lines, deps } = await setup();

    await run(['clean', '--dry-run'], deps);

    expect(remote.files.has(orphan)).toBe(true);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('--yes 删除孤儿,保留被索引引用的对象', async () => {
    const { remote, keep, orphan, lines, deps } = await setup();

    await run(['clean', '--yes'], deps);

    expect(remote.files.has(orphan)).toBe(false);
    expect(remote.files.has(keep)).toBe(true);
    expect(lines.join('\n')).toContain('已删除 1 个对象');
  });

  it('本地模式没有远端可清理', async () => {
    const base = await mkdtemp(join(tmpdir(), 'trove-clean-local-'));
    const paths = trovePaths(base);
    const config = defaultConfig({ deviceId: 'dev1', deviceName: '本机' });
    config.remote = { type: 'webdav', url: '', username: 'webdav', password: '' };
    await saveConfig(paths.config, config);
    const lines: string[] = [];
    const deps = {
      base,
      createRemote: () => {
        throw new Error('不应构造远端');
      },
      resolveAdapters: () => [],
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
      rawOut: () => {},
      isTTY: false,
    };

    await run(['clean'], deps);

    expect(lines.join('\n')).toContain('本地模式');
  });
});

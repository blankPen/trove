import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { collect } from '../src/core/collect.js';
import { emptyState } from '../src/core/state.js';
import type { Adapter } from '../src/adapters/index.js';
import { DatabaseSync } from '../src/sqlite.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

function fileAdapter(root: string, patterns: string[] = ['**/*.jsonl']): Adapter {
  return {
    kind: 'files',
    id: 'claude-code',
    displayName: 'Claude Code',
    source: { id: 'claude-code', displayName: 'Claude Code', root, patterns, exclusions: [] },
  };
}

describe('collect(文件源)', () => {
  it('首次归档全部文件,第二次无变化则全部跳过', async () => {
    const src = await tmp('trove-c-src-');
    const vault = await tmp('trove-c-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(join(src, 'projects/a.jsonl'), 'aaa');
    await writeFile(join(src, 'projects/b.jsonl'), 'bbb');
    const state = emptyState();
    const o = { adapters: [fileAdapter(src)], deviceId: 'dev1', vaultRoot: vault, state, cutoff: 0 };

    const first = await collect(o);
    expect(first.archived).toBe(2);
    expect(await readFile(join(vault, 'raw/dev1/claude-code/projects/a.jsonl'), 'utf8')).toBe('aaa');
    expect(Object.keys(state.sources['claude-code']!)).toHaveLength(2);

    const second = await collect(o);
    expect(second.archived).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.bytesCopied).toBe(0);
  });

  it('追加只搬新增字节', async () => {
    const src = await tmp('trove-c-src-');
    const vault = await tmp('trove-c-vault-');
    await writeFile(join(src, 'a.jsonl'), 'hello');
    const state = emptyState();
    const o = { adapters: [fileAdapter(src)], deviceId: 'dev1', vaultRoot: vault, state, cutoff: 0 };
    await collect(o);

    await writeFile(join(src, 'a.jsonl'), 'hello world');
    const r = await collect(o);

    expect(r.appended).toBe(1);
    expect(r.bytesCopied).toBe(6);
    expect(await readFile(join(vault, 'raw/dev1/claude-code/a.jsonl'), 'utf8')).toBe('hello world');
  });

  it('--since 只收集窗口内变更的会话;已归档的旧会话不受影响', async () => {
    const src = await tmp('trove-c-src-');
    const vault = await tmp('trove-c-vault-');
    await writeFile(join(src, 'old.jsonl'), 'old');
    await writeFile(join(src, 'new.jsonl'), 'new');
    const state = emptyState();

    // old 已在窗口外;先归档它
    const r0 = await collect({
      adapters: [fileAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      cutoff: 0,
    });
    expect(r0.archived).toBe(2);

    // 新的窗口:两个文件 mtime 都不在窗口内 → 全部跳过(但已归档的仍在状态里)
    const r1 = await collect({
      adapters: [fileAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      cutoff: Date.now() + 10_000,
    });
    expect(r1.archived).toBe(0);
    expect(r1.skipped).toBe(0);
    expect(r1.outOfWindow).toBe(2);
    expect(await readFile(join(vault, 'raw/dev1/claude-code/old.jsonl'), 'utf8')).toBe('old');
  });

  it('会话时间取同目录最大 mtime:窗口内的会话会带上同目录旧附件', async () => {
    const src = await tmp('trove-c-src-');
    const vault = await tmp('trove-c-vault-');
    await mkdir(join(src, '.sessions/s1'), { recursive: true });
    await writeFile(join(src, '.sessions/s1/board.md'), 'board');
    await writeFile(join(src, '.sessions/s1/old.jsonl'), 'traj');
    // 让 board.md 显得很新,old.jsonl 很旧
    const old = new Date(Date.now() - 30 * 86400_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(join(src, '.sessions/s1/old.jsonl'), old, old);

    const adapter: Adapter = {
      kind: 'files',
      id: 'doubao',
      displayName: '豆包',
      source: {
        id: 'doubao',
        displayName: '豆包',
        root: src,
        patterns: ['.sessions/**'],
        exclusions: [],
        sessionKeyOf: (rel) => rel.split('/')[1]!,
      },
    };
    const r = await collect({
      adapters: [adapter],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: Date.now() - 7 * 86400_000,
    });
    expect(r.archived).toBe(2);
  });
});

describe('collect(OpenCode SQLite 源)', () => {
  async function db() {
    const dir = await tmp('trove-c-oc-');
    const path = join(dir, 'opencode.db');
    const d = new DatabaseSync(path);
    d.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    d.prepare(
      'INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)',
    ).run('ses_1', 'p', 'slug', '/d', '会话一', '2.0', 100, 200);
    d.prepare(
      'INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)',
    ).run('m1', 'ses_1', 'user', 1, 100, 100, '{"text":"你好"}');
    d.close();
    return path;
  }

  it('导出会话到 vault,重复运行跳过,新增消息后增量追加', async () => {
    const dbPath = await db();
    const vault = await tmp('trove-c-vault-');
    const state = emptyState();
    const adapters: Adapter[] = [
      { kind: 'opencode', id: 'opencode', displayName: 'OpenCode', dbPath },
    ];
    const o = { adapters, deviceId: 'dev1', vaultRoot: vault, state, cutoff: 0, tmpDir: vault };

    const first = await collect(o);
    expect(first.archived).toBe(1);
    const target = join(vault, 'raw/dev1/opencode/sessions/ses_1.jsonl');
    const text = await readFile(target, 'utf8');
    expect(text).toContain('"table":"session_v2"');
    expect(text).toContain('你好');
    expect(state.sources['opencode']!['sessions/ses_1.jsonl']).toMatchObject({ sessionKey: 'ses_1' });

    const second = await collect(o);
    expect(second.skipped).toBe(1);
    expect(second.bytesCopied).toBe(0);

    const d = new DatabaseSync(dbPath);
    d.prepare(
      'INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)',
    ).run('m2', 'ses_1', 'assistant', 2, 300, 300, '{"text":"世界"}');
    d.close();

    const third = await collect(o);
    expect(third.appended).toBe(1);
    const after = await readFile(target, 'utf8');
    expect(after).toContain('你好');
    expect(after).toContain('世界');
  });

  it('--since 过滤掉窗口外的会话', async () => {
    const dbPath = await db();
    const vault = await tmp('trove-c-vault-');
    const adapters: Adapter[] = [
      { kind: 'opencode', id: 'opencode', displayName: 'OpenCode', dbPath },
    ];
    const r = await collect({
      adapters,
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 200_000,
      tmpDir: vault,
    });
    expect(r.archived).toBe(0);
    expect(r.outOfWindow).toBe(1);
  });

  it('数据库文件缺失时静默跳过,不中断整轮收集', async () => {
    const vault = await tmp('trove-c-vault-');
    const missingDb = join(vault, 'no-such-dir', 'opencode.db');
    const adapters: Adapter[] = [
      { kind: 'opencode', id: 'opencode', displayName: 'OpenCode', dbPath: missingDb },
    ];
    const r = await collect({
      adapters,
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
      tmpDir: vault,
    });
    expect(r.discovered).toBe(0);
    expect(r.archived).toBe(0);
  });
});

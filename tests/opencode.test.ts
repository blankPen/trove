import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../src/sqlite.js';
import { describe, it, expect } from 'vitest';
import { exportSession, listSessions } from '../src/adapters/opencode.js';

/** 建一个同时含新旧两套表的最小 OpenCode 库。 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'trove-oc-'));
  const path = join(dir, 'opencode.db');
  const db = openSqlite(path, false);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT, path TEXT,
      agent TEXT, model TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT,
      agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER,
      resume_attempts INTEGER DEFAULT 0 NOT NULL, time_idle INTEGER, time_viewed INTEGER,
      idle_outcome TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);

  const insV2 = db.prepare(
    'INSERT INTO session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated,idle_outcome) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  insV2.run('ses_new', 'p1', 'slug', '/repo', '新会话 🚀', '2.1.0', 1000, 3000, 'succeeded');

  const insOld = db.prepare(
    'INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)',
  );
  insOld.run('ses_new', 'p1', 'slug', '/repo', '旧行也保留', '1.0.0', 1000, 2000);
  insOld.run('ses_legacy', 'p1', 'slug', '/old', '只有旧表', '1.0.0', 500, 900);

  const insMsg = db.prepare(
    'INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)',
  );
  insMsg.run('m2', 'ses_new', 'assistant', 2, 3000, 3000, '{"text":"第二行\\n含换行"}');
  insMsg.run('m1', 'ses_new', 'user', 1, 2000, 2000, '{"text":"第一行"}');

  const insLegacyMsg = db.prepare(
    'INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)',
  );
  insLegacyMsg.run('m1', 'ses_new', 2000, 2000, '{"text":"重复旧行应跳过"}');
  insLegacyMsg.run('m_legacy', 'ses_legacy', 800, 900, '{"text":"旧消息"}');

  const insPart = db.prepare(
    'INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)',
  );
  insPart.run('p_legacy', 'm_legacy', 'ses_legacy', 850, 900, '{"type":"text","text":"旧 part"}');
  insPart.run('p_dup', 'm1', 'ses_new', 2000, 2000, '{"type":"text","text":"新消息的 part 已内嵌,不重复导出"}');
  db.close();
  return { path, dir };
}

function rows(jsonl: string): any[] {
  return jsonl.trim().split('\n').map((l) => JSON.parse(l));
}

describe('OpenCode adapter(SQLite 新旧表并集)', () => {
  it('列出两套表的全部会话,updatedAt 取会话与消息的最大值', async () => {
    const { path } = await fixture();
    const got = listSessions(path).sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual([
      { id: 'ses_legacy', updatedAt: 900 },
      { id: 'ses_new', updatedAt: 3000 },
    ]);
  });

  it('导出会话:保留会话全字段、消息按 seq 排序、旧表补齐缺失消息与 part', async () => {
    const { path } = await fixture();
    const out = rows(await exportSession(path, 'ses_new'));
    expect(out.map((r) => r.table)).toEqual([
      'session_v2',
      'session',
      'session_message',
      'session_message',
      'message',
      'part',
    ]);
    expect(out[0].row.title).toBe('新会话 🚀');
    expect(out[1].row.title).toBe('旧行也保留');
    expect(out[2].row.id).toBe('m1');
    expect(out[3].row.id).toBe('m2');
    expect(out[2].row.data).toBe('{"text":"第一行"}');
    // 新旧序列化都保留
    expect(out[4].row.data).toBe('{"text":"重复旧行应跳过"}');
    expect(out[5].row.data).toBe('{"type":"text","text":"新消息的 part 已内嵌,不重复导出"}');

    const legacy = rows(await exportSession(path, 'ses_legacy'));
    expect(legacy.map((r) => r.table)).toEqual(['session', 'message', 'part']);
    expect(legacy[1].row.data).toBe('{"text":"旧消息"}');
    expect(legacy[2].row.data).toBe('{"type":"text","text":"旧 part"}');
  });

  it('导出是确定性的:同一会话两次导出完全一致', async () => {
    const { path } = await fixture();
    const a = await exportSession(path, 'ses_new');
    const b = await exportSession(path, 'ses_new');
    expect(a).toBe(b);
  });

  it('未知会话 → 空字符串', async () => {
    const { path } = await fixture();
    expect(exportSession(path, 'ses_nope')).toBe('');
  });
});

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { OpenCodeStore, exportSession as exportReal } from '../src/adapters/opencode.js';

const REAL_DB = join(homedir(), '.local/share/opencode/opencode.db');

describe.skipIf(!existsSync(REAL_DB))('真实 OpenCode 库:导出覆盖全部行', () => {
  it('导出行数 = 会话行 + 新表消息 + 旧表独有消息 + 其 part', () => {
    const db = openSqlite(REAL_DB);
    const store = new OpenCodeStore(REAL_DB);
    try {
      const sessions = store.listSessions();
      const target = sessions[sessions.length - 1]!; // 最近变更的会话
      const out = exportReal(REAL_DB, target.id);
      const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { table: string; row: { id?: string } });

      const hasV2 = db.prepare('SELECT 1 FROM session_v2 WHERE id=?').get(target.id) !== undefined;
      const hasLegacy = db.prepare('SELECT 1 FROM session WHERE id=?').get(target.id) !== undefined;
      const newMsgs = db
        .prepare('SELECT id FROM session_message WHERE session_id=?')
        .all(target.id) as Array<{ id: string }>;
      const legacyMsgs = db
        .prepare('SELECT id FROM message WHERE session_id=?')
        .all(target.id) as Array<{ id: string }>;
      const parts = (
        db.prepare('SELECT COUNT(*) c FROM part WHERE session_id=?').get(target.id) as { c: number }
      ).c;
      const expected =
        (hasV2 ? 1 : 0) + (hasLegacy ? 1 : 0) + newMsgs.length + legacyMsgs.length + parts;
      expect(lines.length).toBe(expected);
      expect(lines.filter((l) => l.table === 'session_v2')).toHaveLength(hasV2 ? 1 : 0);
      expect(lines.filter((l) => l.table === 'session_message')).toHaveLength(newMsgs.length);

      // 逐行与数据库原值比对:所有列都必须原样保留
      const rowOf = (table: string, id: string) =>
        db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      for (const line of lines) {
        if (!line.row.id) continue;
        const original = rowOf(line.table, line.row.id);
        expect(original, `${line.table}:${line.row.id}`).toBeDefined();
        expect(JSON.parse(JSON.stringify(line.row))).toEqual(JSON.parse(JSON.stringify(original)));
      }
    } finally {
      store.close();
      db.close();
    }
  }, 120_000);
});

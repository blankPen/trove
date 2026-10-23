import { openSqlite, type DatabaseSync } from '../sqlite.js';

/**
 * OpenCode 适配器(设计:SQLite 全表对比,Beacon 游标档位 3)。
 *
 * OpenCode 1.x 同时存在两套表:
 *   - 新:session_v2 + session_message(消息内容含 parts,data 为完整 JSON)
 *   - 旧:session + message + part
 * 新表只覆盖了旧表的一部分,因此导出取并集,任何一行的字段都原样保留。
 * 只读打开源库;归档内容是每会话一份确定性 JSONL。
 */

export interface OpenCodeSession {
  id: string;
  updatedAt: number;
}

/** 导出格式版本:导出逻辑变化时递增,collect 会据此强制重导(旧归档自动换世代)。 */
export const OPENCODE_EXPORT_VERSION = 2;

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export class OpenCodeStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openSqlite(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 列出全部会话(新表 + 仅存在于旧表的会话),updatedAt 取会话/消息/part 的最大值。 */
  listSessions(cutoff = 0): OpenCodeSession[] {
    const out = new Map<string, number>();
    const v2 = hasTable(this.db, 'session_v2');
    const msgs = hasTable(this.db, 'session_message');

    if (v2) {
      const rows = this.db
        .prepare(
          `SELECT s.id AS id,
             MAX(s.time_updated, COALESCE((
               ${msgs ? 'SELECT MAX(m.time_updated) FROM session_message m WHERE m.session_id=s.id' : 'SELECT 0'}
             ),0)) AS updatedAt
           FROM session_v2 s`,
        )
        .all() as Array<{ id: string; updatedAt: number }>;
      for (const r of rows) out.set(r.id, Number(r.updatedAt));
    }

    if (hasTable(this.db, 'session')) {
      const legacyOnly = v2 ? 'WHERE NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id=s.id)' : '';
      const msgAgg = hasTable(this.db, 'message')
        ? 'COALESCE((SELECT MAX(m.time_updated) FROM message m WHERE m.session_id=s.id),0)'
        : '0';
      const partAgg = hasTable(this.db, 'part')
        ? 'COALESCE((SELECT MAX(p.time_updated) FROM part p WHERE p.session_id=s.id),0)'
        : '0';
      const rows = this.db
        .prepare(
          `SELECT s.id AS id, MAX(s.time_updated, ${msgAgg}, ${partAgg}) AS updatedAt
           FROM session s ${legacyOnly}`,
        )
        .all() as Array<{ id: string; updatedAt: number }>;
      for (const r of rows) out.set(r.id, Number(r.updatedAt));
    }

    return [...out]
      .map(([id, updatedAt]) => ({ id, updatedAt }))
      .filter((s) => s.updatedAt >= cutoff)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  }

  /**
   * 导出单个会话为确定性 JSONL:每个数据库行一行,保留全部列。
   * 行格式:{"v":1,"table":"session_v2","row":{...}}
   */
  exportSession(sessionId: string): string {
    const lines: string[] = [];
    const emit = (table: string, row: unknown) => {
      lines.push(JSON.stringify({ v: 1, table, row }));
    };

    let exists = false;
    if (hasTable(this.db, 'session_v2')) {
      const row = this.db.prepare('SELECT * FROM session_v2 WHERE id=?').get(sessionId);
      if (row) {
        emit('session_v2', row);
        exists = true;
      }
    }
    if (hasTable(this.db, 'session')) {
      const row = this.db.prepare('SELECT * FROM session WHERE id=?').get(sessionId);
      if (row) {
        emit('session', row);
        exists = true;
      }
    }
    if (!exists) return '';

    // 新表消息:seq 是会话内唯一顺序号,缺列时退回时间+id
    const newMessageIds = new Set<string>();
    if (hasTable(this.db, 'session_message')) {
      const cols = columns(this.db, 'session_message');
      const order = cols.has('seq') ? 'seq ASC, id ASC' : 'time_created ASC, id ASC';
      const rows = this.db
        .prepare(`SELECT * FROM session_message WHERE session_id=? ORDER BY ${order}`)
        .all(sessionId) as Array<Record<string, unknown>>;
      for (const row of rows) {
        emit('session_message', row);
        newMessageIds.add(String(row.id));
      }
    }

    // 旧表消息:新旧同 id 的 data 序列化并不相同(实测 23504 条不同),为无损全部保留。
    // 新表已内嵌 parts,这里仍保留旧 part,避免丢失旧序列化里的任何字段。
    if (hasTable(this.db, 'message')) {
      const rows = this.db
        .prepare('SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC, id ASC')
        .all(sessionId) as Array<Record<string, unknown>>;
      for (const row of rows) emit('message', row);
    }
    if (hasTable(this.db, 'part')) {
      const rows = this.db
        .prepare('SELECT * FROM part WHERE session_id=? ORDER BY message_id ASC, time_created ASC, id ASC')
        .all(sessionId) as Array<Record<string, unknown>>;
      for (const row of rows) emit('part', row);
    }

    return lines.length ? lines.join('\n') + '\n' : '';
  }
}

/** 便捷函数(测试/单次导出)。 */
export function listSessions(dbPath: string, cutoff = 0): OpenCodeSession[] {
  const store = new OpenCodeStore(dbPath);
  try {
    return store.listSessions(cutoff);
  } finally {
    store.close();
  }
}

export function exportSession(dbPath: string, sessionId: string): string {
  const store = new OpenCodeStore(dbPath);
  try {
    return store.exportSession(sessionId);
  } finally {
    store.close();
  }
}

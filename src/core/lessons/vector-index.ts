/** 向量索引：独立 SQLite 库（vectors.sqlite），暴力余弦检索 + 元数据表。 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqlite, type DatabaseSync } from '../../sqlite.js';

export interface VectorRow {
  memoryId: string;
  path: string;
  scope?: string;
  vector: Float32Array;
  /** 编码时的 updated_at 毫秒时间戳；0 表示无有效时间。 */
  updatedAt: number;
}

export interface VectorHit {
  memoryId: string;
  path: string;
  scope?: string;
  score: number;
}

/** 余弦相似度；长度不同或任一零向量返回 0。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class VectorIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): VectorIndex {
    mkdirSync(dirname(path), { recursive: true });
    const db = openSqlite(path, false);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        memory_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        scope TEXT,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return new VectorIndex(db);
  }

  close(): void {
    this.db.close();
  }

  upsert(memoryId: string, path: string, scope: string | undefined, vector: Float32Array, updatedAt = 0): void {
    this.db
      .prepare(
        'INSERT INTO vectors(memory_id,path,scope,vector,updated_at) VALUES(?,?,?,?,?) ' +
          'ON CONFLICT(memory_id) DO UPDATE SET path=excluded.path, scope=excluded.scope, vector=excluded.vector, updated_at=excluded.updated_at',
      )
      .run(memoryId, path, scope ?? null, encodeVector(vector), updatedAt);
  }

  get(memoryId: string): VectorRow | null {
    const row = this.db
      .prepare('SELECT memory_id,path,scope,vector,updated_at FROM vectors WHERE memory_id=?')
      .get(memoryId) as { memory_id: string; path: string; scope: string | null; vector: Uint8Array; updated_at: number } | undefined;
    if (!row) return null;
    return {
      memoryId: row.memory_id,
      path: row.path,
      ...(row.scope ? { scope: row.scope } : {}),
      vector: decodeVector(row.vector),
      updatedAt: row.updated_at,
    };
  }

  remove(memoryId: string): void {
    this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(memoryId);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number };
    return row.n;
  }

  all(): VectorRow[] {
    const rows = this.db
      .prepare('SELECT memory_id,path,scope,vector,updated_at FROM vectors')
      .all() as unknown as Array<{ memory_id: string; path: string; scope: string | null; vector: Uint8Array; updated_at: number }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      path: r.path,
      ...(r.scope ? { scope: r.scope } : {}),
      vector: decodeVector(r.vector),
      updatedAt: r.updated_at,
    }));
  }

  search(query: Float32Array, topK: number): VectorHit[] {
    const k = Math.max(0, Math.floor(topK));
    if (k === 0) return [];
    return this.all()
      .map((r) => ({ memoryId: r.memoryId, path: r.path, ...(r.scope ? { scope: r.scope } : {}), score: cosineSimilarity(query, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  clear(): void {
    this.db.exec('DELETE FROM vectors; DELETE FROM meta');
  }
}

/** Float32Array → 显式小端 BLOB（不依赖平台字节序）。 */
function encodeVector(v: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i]!, true);
  return new Uint8Array(buf);
}

function decodeVector(b: Uint8Array): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(b.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

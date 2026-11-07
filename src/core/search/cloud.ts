/**
 * 阿里百炼云端向量：OpenAI 兼容 embeddings + 本地 SQLite 向量缓存。
 * 全程不加载 llama.cpp/GGUF，配置 provider=dashscope 时本地模型不下载、不启动。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openSqlite, type DatabaseSync } from '../../sqlite.js';
import { libraryLessonsDir } from '../layout.js';
import { parseFrontmatter, stripFrontmatter } from '../lessons/frontmatter.js';
import { CATEGORY_CONTEXT, LESSON_CATEGORIES } from './categories.js';
import { walkLessons } from './lessons-index.js';

export interface CloudSearchConfig {
  /** 向量缓存 SQLite 路径（本地可重建，不参与同步）。 */
  dbPath: string;
  apiKey: string;
  /** OpenAI 兼容端点，如 https://dashscope.aliyuncs.com/compatible-mode/v1。 */
  baseUrl: string;
  model: string;
  dimension: number;
  /** 余弦相似度下限；低于此分不返回（0 = 不过滤）。 */
  minScore?: number;
}

/** 百炼单请求最多 10 条文本。 */
const BATCH_SIZE = 10;
/**
 * 单条上限 8192 token；中文按 1 字约 1 token 估，留足余量。
 * shortcut: 超长文档只嵌前 6000 字，需要整篇语义时再改成分片嵌入。
 */
const MAX_CHARS = 6000;
const TIMEOUT_MS = 30_000;

export interface CloudHit {
  path: string;
  score: number;
}

export interface CloudSyncResult {
  documents: number;
  chunksEmbedded: number;
  needsEmbedding: number;
}

/** 文本向量：按 10 条一批调用云端接口，顺序与入参一致。 */
export async function embedTexts(cfg: CloudSearchConfig, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(cfg, texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

async function embedBatch(cfg: CloudSearchConfig, texts: string[]): Promise<Float32Array[]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const body = JSON.stringify({
    model: cfg.model,
    input: texts.map((t) => [...t].slice(0, MAX_CHARS).join('')),
    dimensions: cfg.dimension,
    encoding_format: 'float',
  });
  const res = await requestWithRetry(url, cfg.apiKey, body);
  let payload: { data?: Array<{ index?: number; embedding?: unknown }> };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new Error(`百炼 embeddings 返回无法解析:HTTP ${res.status}`);
  }
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`百炼 embeddings 返回条数异常:期望 ${texts.length},实际 ${Array.isArray(data) ? data.length : '无 data'}`);
  }
  const out = new Array<Float32Array>(texts.length);
  for (const item of data) {
    const i = item.index ?? 0;
    if (!Array.isArray(item.embedding)) throw new Error('百炼 embeddings 返回缺少 embedding 数组');
    out[i] = Float32Array.from(item.embedding as number[]);
  }
  return out;
}

/** 429/5xx/网络错误重试一次；其它状态直接抛，错误信息带状态码与响应摘要（不含密钥）。 */
async function requestWithRetry(url: string, apiKey: string, body: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const err = new Error(`百炼 embeddings 调用失败:HTTP ${res.status} ${text.slice(0, 300)}`);
    if (res.status !== 429 && res.status < 500) throw err;
    lastError = err;
  }
  throw lastError instanceof Error ? lastError : new Error('百炼 embeddings 调用失败');
}

/** 文档嵌入文本：类目描述 + 标题 + 标签 + 正文（去掉 frontmatter）。 */
export function cloudDocText(path: string, raw: string): string {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw) ?? raw;
  const category = path.split('/')[0] as (typeof LESSON_CATEGORIES)[number];
  const ctx = CATEGORY_CONTEXT[category] ?? '';
  return [ctx, fm?.title ?? '', (fm?.tags ?? []).join(' '), body].filter(Boolean).join('\n');
}

interface VectorRow {
  path: string;
  mtimeMs: number;
  size: number;
  vector: Float32Array;
}

/** 向量缓存表：path 为主键，保存文件 mtime/size 用于增量判断。 */
class CloudVectorIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): CloudVectorIndex {
    mkdirSync(dirname(path), { recursive: true });
    const db = openSqlite(path, false);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return new CloudVectorIndex(db);
  }

  close(): void {
    this.db.close();
  }

  get(path: string): VectorRow | null {
    const row = this.db
      .prepare('SELECT path,mtime_ms,size,vector FROM vectors WHERE path=?')
      .get(path) as StoredRow | undefined;
    return row ? toRow(row) : null;
  }

  upsert(path: string, mtimeMs: number, size: number, vector: Float32Array): void {
    this.db
      .prepare(
        'INSERT INTO vectors(path,mtime_ms,size,vector) VALUES(?,?,?,?) ' +
          'ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size=excluded.size, vector=excluded.vector',
      )
      .run(path, mtimeMs, size, encodeVector(vector));
  }

  /** 删除不再存在的文件对应的向量；返回删除条数。 */
  removeMissing(existing: Set<string>): number {
    let removed = 0;
    const rows = this.db.prepare('SELECT path FROM vectors').all() as unknown as Array<{ path: string }>;
    for (const row of rows) {
      if (existing.has(row.path)) continue;
      this.db.prepare('DELETE FROM vectors WHERE path=?').run(row.path);
      removed++;
    }
    return removed;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number };
    return row.n;
  }

  all(): VectorRow[] {
    return (this.db.prepare('SELECT path,mtime_ms,size,vector FROM vectors').all() as unknown as StoredRow[]).map(
      toRow,
    );
  }

  search(query: Float32Array, topK: number): CloudHit[] {
    const k = Math.max(0, Math.floor(topK));
    if (k === 0) return [];
    return this.all()
      .map((r) => ({ path: r.path, score: cosineSimilarity(query, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      key,
      value,
    );
  }

  clear(): void {
    this.db.exec('DELETE FROM vectors; DELETE FROM meta');
  }
}

/**
 * 增量同步云端向量：文件 mtime/size 变化才重新嵌入；
 * 模型或维度变化时清空重嵌（向量不可跨模型复用，同 qmd）。
 */
export async function syncCloudIndex(vaultRoot: string, cfg: CloudSearchConfig): Promise<CloudSyncResult> {
  const index = CloudVectorIndex.open(cfg.dbPath);
  try {
    const modelKey = `${cfg.model}@${cfg.dimension}`;
    if (index.getMeta('model') !== modelKey) {
      index.clear();
      index.setMeta('model', modelKey);
    }
    const root = libraryLessonsDir(vaultRoot);
    const files = await walkLessons(root);
    const existing = new Set(files);
    const pending: Array<{ path: string; mtimeMs: number; size: number; text: string }> = [];
    for (const rel of files) {
      const abs = join(root, rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      const mtimeMs = Math.floor(st.mtimeMs);
      const prev = index.get(rel);
      if (prev && prev.mtimeMs === mtimeMs && prev.size === st.size) continue;
      let raw: string;
      try {
        raw = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      pending.push({ path: rel, mtimeMs, size: st.size, text: cloudDocText(rel, raw) });
    }
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const vectors = await embedTexts(cfg, batch.map((b) => b.text));
      batch.forEach((b, j) => index.upsert(b.path, b.mtimeMs, b.size, vectors[j]!));
    }
    index.removeMissing(existing);
    return { documents: index.count(), chunksEmbedded: pending.length, needsEmbedding: 0 };
  } finally {
    index.close();
  }
}

/** 向量召回：索引不存在或为空时返回空（检索降级纯 FTS）；云端不可达时由调用方兜底。 */
export async function cloudVectorSearch(
  query: string,
  cfg: CloudSearchConfig,
  limit = 50,
): Promise<CloudHit[]> {
  if (!existsSync(cfg.dbPath)) return [];
  const [vector] = await embedTexts(cfg, [query]);
  if (!vector) return [];
  const index = CloudVectorIndex.open(cfg.dbPath);
  try {
    const floor = cfg.minScore ?? 0;
    // 余弦 ≤ 0 表示正交或负相关，不算命中；minScore=0 时不额外抬门槛。
    return index.search(vector, limit).filter((h) => h.score > 0 && h.score >= floor);
  } finally {
    index.close();
  }
}

/** 索引状态：文档数；索引不存在返回 null。 */
export function cloudIndexStatus(cfg: CloudSearchConfig): { documents: number; needsEmbedding: number } | null {
  if (!existsSync(cfg.dbPath)) return null;
  try {
    const index = CloudVectorIndex.open(cfg.dbPath);
    try {
      return { documents: index.count(), needsEmbedding: 0 };
    } finally {
      index.close();
    }
  } catch {
    return null;
  }
}

interface StoredRow {
  path: string;
  mtime_ms: number;
  size: number;
  vector: Uint8Array;
}

function toRow(r: StoredRow): VectorRow {
  return { path: r.path, mtimeMs: r.mtime_ms, size: r.size, vector: decodeVector(r.vector) };
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
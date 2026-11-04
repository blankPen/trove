/** sessions 检索：本地 SQLite FTS5 持久索引 + 渐进式读取 JSONL。 */
import { mkdirSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openSqlite, type DatabaseSync } from '../../sqlite.js';
import type { Event } from '../events/schema.js';
import { libraryDir } from '../layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from '../library/index-file.js';
import { sessionKeyOf, type LibraryIndex, type MergedSession } from '../library/schema.js';
import { listSessions } from '../sessions.js';
import { isSingleCjkQuery, toFtsQuery, tokenizeText } from './tokenize.js';
import { redact } from './redact.js';
import {
  clip,
  exactBonus,
  projectAffinity,
  recencyBoost,
  snippetAround,
  type ScoreParts,
} from './rank.js';

export interface SessionHit {
  session: string;
  harness: string;
  devices: string[];
  startedAt?: string;
  cwd?: string;
  title?: string;
  snippet: string;
  score: number;
  scoreParts: ScoreParts;
}

export interface SessionEvent {
  seq: number;
  ts?: string;
  kind: string;
  role?: string;
  text: string;
}

export interface SessionDetail {
  session: string;
  harness: string;
  devices: string[];
  startedAt?: string;
  cwd?: string;
  title?: string;
  path: string;
  events: SessionEvent[];
}

export interface SessionSearchOptions {
  query: string;
  harness?: string;
  device?: string;
  since?: number;
  limit?: number;
  exact?: boolean;
  cwd?: string;
}

export interface SessionIndexStatus {
  indexedSessions: number;
  totalSessions: number;
  builtAt?: string;
  stale: boolean;
  sizeBytes: number;
}

export interface BuildStats {
  scanned: number;
  changed: number;
  removed: number;
  tookMs: number;
  sizeBytes: number;
}

const SCHEMA_VERSION = '1';

interface MetaRow {
  id: number;
  sid: string;
  harness: string;
  devices: string;
  path: string;
  started_at: string;
  hash: string;
}

interface FtsRow {
  sid: string;
  harness: string;
  devices: string;
  path: string;
  started_at: string;
  score: number;
}

interface SessionDoc {
  meta: string;
  body: string;
}

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM search_meta WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO search_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    value,
  );
}

function indexPathOf(vaultRoot: string): string {
  return join(libraryDir(vaultRoot), 'index.json');
}

/** 读取 index.json；缺失或落后于 library/sessions 目录 mtime 时重建。 */
async function loadFreshIndex(vaultRoot: string): Promise<LibraryIndex> {
  const indexPath = indexPathOf(vaultRoot);
  let indexMtime = 0;
  try {
    indexMtime = (await stat(indexPath)).mtimeMs;
  } catch {
    // 缺失
  }
  let libraryMtime = 0;
  try {
    libraryMtime = (await stat(join(libraryDir(vaultRoot), 'sessions'))).mtimeMs;
  } catch {
    // 空库
  }
  const cached = await loadLibraryIndex(vaultRoot);
  if (cached && libraryMtime <= indexMtime) return cached;
  return rebuildUnifiedIndex(vaultRoot);
}

function sidOf(s: MergedSession): string {
  return sessionKeyOf(s.harness, s.session);
}

function canonicalPath(vaultRoot: string, s: MergedSession): string {
  return join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
}

function eventHaystack(e: Event): string {
  const parts: string[] = [];
  if (e.text) parts.push(e.text);
  if (e.tool?.name) parts.push(e.tool.name);
  if (e.tool?.input !== undefined) parts.push(JSON.stringify(e.tool.input));
  if (e.result?.output !== undefined) {
    parts.push(typeof e.result.output === 'string' ? e.result.output : JSON.stringify(e.result.output));
  }
  return parts.join('\n');
}

/** 系统注入的 caveat/续写摘要不是用户内容，索引与片段都应跳过。 */
function isNoiseText(text: string): boolean {
  const t = text.trimStart().toLowerCase();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('caveat:') ||
    t.startsWith('this session is being continued')
  );
}

async function readSessionDoc(vaultRoot: string, s: MergedSession): Promise<SessionDoc> {
  let raw: string;
  try {
    raw = await readFile(canonicalPath(vaultRoot, s), 'utf8');
  } catch {
    return { meta: '', body: '' };
  }
  let header: Event | undefined;
  const body: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (e.kind === 'session') {
      header = e;
      continue;
    }
    if (e.kind === 'message' || e.kind === 'reasoning') {
      if (e.text && !isNoiseText(e.text)) body.push(e.text.slice(0, 8192));
    } else if (e.kind === 'tool_call') {
      body.push(JSON.stringify(e.tool?.input ?? e.text ?? '').slice(0, 1024));
    } else if (e.kind === 'tool_result') {
      body.push(String(e.result?.output ?? e.text ?? '').slice(0, 1024));
    } else if (e.text) {
      body.push(e.text.slice(0, 1024));
    }
  }
  const meta = [
    s.title,
    s.firstText,
    s.cwd,
    s.model,
    s.session,
    s.harness,
    header?.title,
    header?.firstText,
    header?.cwd,
    header?.model?.id,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && !isNoiseText(v))
    .join('\n');
  return { meta, body: body.join('\n') };
}

async function readSnippet(vaultRoot: string, s: MergedSession, query: string): Promise<string> {
  try {
    const raw = await readFile(canonicalPath(vaultRoot, s), 'utf8');
    const needle = query.toLowerCase();
    let fallback = '';
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        continue;
      }
      const hay = eventHaystack(e);
      if (!hay || isNoiseText(hay)) continue;
      if (!hay.toLowerCase().includes(needle)) continue;
      if (e.kind === 'message' || e.kind === 'reasoning') {
        return snippetAround(redact(hay), query);
      }
      if (!fallback) fallback = hay;
    }
    if (fallback) return snippetAround(redact(fallback), query);
  } catch {
    // 文件缺失时退回标题
  }
  const title = s.title ?? s.firstText ?? '';
  return isNoiseText(title) ? '' : clip(redact(title), 200);
}

export class SessionsIndex {
  private lastIndexMtime = 0;

  private constructor(
    private readonly db: DatabaseSync,
    readonly dbPath: string,
  ) {}

  static open(dbPath: string): SessionsIndex {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openSqlite(dbPath, false);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions_meta (
        id INTEGER PRIMARY KEY,
        sid TEXT UNIQUE NOT NULL,
        harness TEXT NOT NULL,
        devices TEXT NOT NULL,
        path TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT,
        hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        meta_tok, body_tok, tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    const version = metaValue(db, 'schema_version');
    if (version && version !== SCHEMA_VERSION) {
      db.exec('DROP TABLE sessions_fts; DROP TABLE sessions_meta;');
      db.exec(`
        CREATE TABLE sessions_meta (
          id INTEGER PRIMARY KEY,
          sid TEXT UNIQUE NOT NULL,
          harness TEXT NOT NULL,
          devices TEXT NOT NULL,
          path TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT,
          hash TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE sessions_fts USING fts5(
          meta_tok, body_tok, tokenize='unicode61'
        );
      `);
    }
    setMeta(db, 'schema_version', SCHEMA_VERSION);
    return new SessionsIndex(db, dbPath);
  }

  close(): void {
    this.db.close();
  }

  async build(
    vaultRoot: string,
    opts: { force?: boolean; since?: number } = {},
  ): Promise<BuildStats> {
    const started = Date.now();
    const index = await loadFreshIndex(vaultRoot);
    const existing = new Map<string, { id: number; hash: string }>();
    for (const row of this.db.prepare('SELECT id,sid,hash FROM sessions_meta').all() as unknown as MetaRow[]) {
      existing.set(row.sid, { id: Number(row.id), hash: row.hash });
    }
    let changed = 0;
    let scanned = 0;
    const seen = new Set<string>();
    this.db.exec('BEGIN');
    try {
      for (const s of Object.values(index.sessions)) {
        const sid = sidOf(s);
        seen.add(sid);
        if (opts.since && s.startedAt && Date.parse(s.startedAt) < opts.since) continue;
        scanned++;
        const prev = existing.get(sid);
        if (!opts.force && prev && prev.hash === s.canonical.hash) continue;
        const doc = await readSessionDoc(vaultRoot, s);
        this.upsert(sid, s, doc, prev?.id);
        changed++;
      }
      let removed = 0;
      for (const [sid, prev] of existing) {
        if (seen.has(sid)) continue;
        this.db.prepare('DELETE FROM sessions_fts WHERE rowid = ?').run(prev.id);
        this.db.prepare('DELETE FROM sessions_meta WHERE id = ?').run(prev.id);
        removed++;
      }
      this.db.exec('COMMIT');
      const mtime = await this.indexMtime(vaultRoot);
      setMeta(this.db, 'built_at', new Date().toISOString());
      setMeta(this.db, 'source_mtime', String(mtime));
      this.db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('optimize')");
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // 全量重建会留下大量 FTS 删除空洞；force 时顺手回收，避免索引越建越大。
      if (opts.force) {
        this.db.exec('VACUUM');
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
      this.lastIndexMtime = mtime;
      return { scanned, changed, removed, tookMs: Date.now() - started, sizeBytes: this.sizeBytes() };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 变化不超过 maxInline 时就地增量；超过则标记 stale，等 trove index build。 */
  async ensureFresh(vaultRoot: string, maxInline = 50): Promise<{ stale: boolean; changed: number }> {
    const mtime = await this.indexMtime(vaultRoot);
    if (mtime === 0) return { stale: false, changed: 0 };
    if (this.lastIndexMtime === mtime) return { stale: false, changed: 0 };
    const index = await loadFreshIndex(vaultRoot);
    const existing = new Map<string, { id: number; hash: string }>();
    for (const row of this.db.prepare('SELECT id,sid,hash FROM sessions_meta').all() as unknown as MetaRow[]) {
      existing.set(row.sid, { id: Number(row.id), hash: row.hash });
    }
    const changed: MergedSession[] = [];
    for (const s of Object.values(index.sessions)) {
      if (existing.get(sidOf(s))?.hash !== s.canonical.hash) changed.push(s);
    }
    const seen = new Set(Object.keys(index.sessions).map((key) => key));
    const removed = [...existing.keys()].filter((sid) => !seen.has(sid));
    if (changed.length > maxInline) {
      this.lastIndexMtime = mtime;
      return { stale: true, changed: changed.length };
    }
    this.db.exec('BEGIN');
    try {
      for (const sid of removed) {
        const prev = existing.get(sid)!;
        this.db.prepare('DELETE FROM sessions_fts WHERE rowid = ?').run(prev.id);
        this.db.prepare('DELETE FROM sessions_meta WHERE id = ?').run(prev.id);
      }
      for (const s of changed) {
        this.upsert(sidOf(s), s, await readSessionDoc(vaultRoot, s), existing.get(sidOf(s))?.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    setMeta(this.db, 'built_at', new Date().toISOString());
    setMeta(this.db, 'source_mtime', String(mtime));
    this.lastIndexMtime = mtime;
    return { stale: false, changed: changed.length };
  }

  async search(
    vaultRoot: string,
    opts: SessionSearchOptions,
  ): Promise<{ results: SessionHit[]; stale: boolean }> {
    const query = opts.query.trim();
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    if (!query) return { results: [], stale: false };
    const fresh = await this.ensureFresh(vaultRoot);
    const indexed = countRows(this.db, 'SELECT COUNT(*) AS n FROM sessions_meta');
    if (opts.exact || isSingleCjkQuery(query) || indexed === 0) {
      return { results: await this.exact(vaultRoot, opts, limit), stale: fresh.stale };
    }
    const fts = toFtsQuery(query);
    if (!fts) return { results: [], stale: fresh.stale };
    const rows = this.db
      .prepare(
        'SELECT m.sid,m.harness,m.devices,m.path,m.started_at,bm25(sessions_fts,5.0,1.0) AS score ' +
          'FROM sessions_fts JOIN sessions_meta m ON m.id = sessions_fts.rowid ' +
          'WHERE sessions_fts MATCH ? ORDER BY score LIMIT 300',
      )
      .all(fts) as unknown as FtsRow[];
    const index = await loadFreshIndex(vaultRoot);
    const now = Date.now();
    const hits: SessionHit[] = [];
    for (const row of rows) {
      if (opts.harness && row.harness !== opts.harness) continue;
      const devices = parseDevices(row.devices);
      if (opts.device && !devices.includes(opts.device)) continue;
      if (opts.since && row.started_at && Date.parse(row.started_at) < opts.since) continue;
      const s = index?.sessions[row.sid];
      const title = s?.title ?? s?.firstText;
      const parts: ScoreParts = {
        bm25: -Number(row.score) || 0,
        recency: recencyBoost(s?.startedAt, 90, 1.5, now),
        exact: exactBonus(`${title ?? ''}\n${s?.firstText ?? ''}`, query),
        project: projectAffinity(s?.cwd, query, 1),
      };
      hits.push({
        session: s?.session ?? row.sid.split(':').slice(1).join(':'),
        harness: row.harness,
        devices,
        ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s?.cwd ? { cwd: s.cwd } : {}),
        ...(title ? { title } : {}),
        snippet: '',
        score: parts.bm25 + parts.recency + parts.exact + parts.project,
        scoreParts: parts,
      });
    }
    hits.sort((a, b) => b.score - a.score || (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const top = hits.slice(0, limit);
    for (const hit of top) {
      const s = index?.sessions[`${hit.harness}:${hit.session}`];
      if (s) hit.snippet = await readSnippet(vaultRoot, s, query);
    }
    return { results: top, stale: fresh.stale };
  }

  private async exact(
    vaultRoot: string,
    opts: SessionSearchOptions,
    limit: number,
  ): Promise<SessionHit[]> {
    const found = await listSessions(vaultRoot, {
      ...(opts.harness ? { harness: opts.harness } : {}),
      ...(opts.device ? { device: opts.device } : {}),
      grep: opts.query,
    });
    return found.slice(0, limit).map((s) => ({
      session: s.session,
      harness: s.harness,
      devices: s.devices,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.title ?? s.firstText ? { title: s.title ?? s.firstText } : {}),
      snippet: clip(redact(s.title ?? s.firstText ?? s.cwd ?? ''), 200),
      score: 0,
      scoreParts: { bm25: 0, recency: 0, exact: 0, project: 0 },
    }));
  }

  async get(
    vaultRoot: string,
    sessionId: string,
    opts: { harness?: string; around?: string; limit?: number } = {},
  ): Promise<SessionDetail | null> {
    const index = await loadFreshIndex(vaultRoot);
    const target =
      index.sessions[sessionId] ??
      Object.values(index.sessions).find(
        (s) =>
          (s.session === sessionId || s.session.endsWith(sessionId)) &&
          (!opts.harness || s.harness === opts.harness),
      );
    if (!target) return null;
    let raw: string;
    try {
      raw = await readFile(canonicalPath(vaultRoot, target), 'utf8');
    } catch {
      return null;
    }
    const events: Event[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        // 跳过损坏行
      }
    }
    const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
    let start = 0;
    if (opts.around) {
      const needle = opts.around.toLowerCase();
      // 优先定位自然语言事件，避免一上来就命中巨大的工具调用参数。
      const preferred = events.findIndex(
        (e) =>
          (e.kind === 'message' || e.kind === 'reasoning') &&
          eventHaystack(e).toLowerCase().includes(needle),
      );
      const any = preferred >= 0 ? preferred : events.findIndex((e) => eventHaystack(e).toLowerCase().includes(needle));
      if (any >= 0) start = Math.max(0, any - Math.floor(limit / 2));
    }
    const picked = events.slice(start, start + limit);
    const rawTitle = target.title ?? target.firstText;
    const noisyTitle =
      !rawTitle || isNoiseText(rawTitle) || rawTitle.trimStart().startsWith('<');
    const derived = events.find(
      (e) => e.kind === 'message' && e.role === 'user' && e.text && !isNoiseText(e.text),
    )?.text;
    const title = noisyTitle && derived ? clip(derived, 120) : rawTitle;
    return {
      session: target.session,
      harness: target.harness,
      devices: target.sources,
      ...(target.startedAt ? { startedAt: target.startedAt } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(title ? { title } : {}),
      path: target.canonical.path,
      events: picked.map((e) => ({
        seq: e.seq,
        ...(e.ts ? { ts: e.ts } : {}),
        kind: e.kind,
        ...(e.role ? { role: e.role } : {}),
        text: redact(
          clip(eventHaystack(e), e.kind === 'message' || e.kind === 'reasoning' ? 2048 : 800),
        ),
      })),
    };
  }

  async status(vaultRoot: string): Promise<SessionIndexStatus> {
    const indexedSessions = countRows(this.db, 'SELECT COUNT(*) AS n FROM sessions_meta');
    const index = await loadLibraryIndex(vaultRoot);
    const mtime = await this.indexMtime(vaultRoot);
    return {
      indexedSessions,
      totalSessions: index ? Object.keys(index.sessions).length : 0,
      ...(metaValue(this.db, 'built_at') ? { builtAt: metaValue(this.db, 'built_at')! } : {}),
      stale: mtime !== 0 && metaValue(this.db, 'source_mtime') !== String(mtime),
      sizeBytes: this.sizeBytes(),
    };
  }

  private upsert(sid: string, s: MergedSession, doc: SessionDoc, existingId?: number): void {
    const startedAt = s.startedAt ?? '';
    const hash = s.canonical.hash;
    let id: number;
    if (existingId !== undefined) {
      id = existingId;
      this.db
        .prepare(
          'UPDATE sessions_meta SET harness=?,devices=?,path=?,started_at=?,updated_at=?,hash=? WHERE id=?',
        )
        .run(s.harness, JSON.stringify(s.sources), s.canonical.path, startedAt, startedAt, hash, id);
      this.db.prepare('DELETE FROM sessions_fts WHERE rowid = ?').run(id);
    } else {
      const res = this.db
        .prepare(
          'INSERT INTO sessions_meta(harness,devices,path,started_at,updated_at,hash,sid) VALUES(?,?,?,?,?,?,?)',
        )
        .run(s.harness, JSON.stringify(s.sources), s.canonical.path, startedAt, startedAt, hash, sid);
      id = Number(res.lastInsertRowid);
    }
    this.db
      .prepare('INSERT INTO sessions_fts(rowid,meta_tok,body_tok) VALUES(?,?,?)')
      .run(id, tokenizeText(doc.meta), tokenizeText(doc.body));
  }

  private async indexMtime(vaultRoot: string): Promise<number> {
    try {
      return (await stat(indexPathOf(vaultRoot))).mtimeMs;
    } catch {
      return 0;
    }
  }

  private sizeBytes(): number {
    try {
      let n = statSync(this.dbPath).size;
      try {
        n += statSync(`${this.dbPath}-wal`).size;
      } catch {
        // 无 WAL
      }
      return n;
    } catch {
      return 0;
    }
  }
}

function parseDevices(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

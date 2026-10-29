/** 阶段 8:审计日志。把阶段 6 的操作转成可回溯的 memory_diff 并落盘,提供人可读摘要。 */
import type { MemoryOp } from './merge.js';
import type { StorageAdapter } from './storage.js';

export interface AddEntry {
  uri: string;
  title: string;
  evidence: number[];
}

export interface UpdateEntry {
  uri: string;
  title: string;
  before: string;
  after: string;
}

export interface AppendEntry {
  uri: string;
}

export interface SkipEntry {
  type: string;
  title: string;
  reason: string;
}

export interface MemoryDiff {
  session_id: string;
  project: string;
  extracted_at: string;
  operations: {
    adds: AddEntry[];
    updates: UpdateEntry[];
    appends: AppendEntry[];
    skips: SkipEntry[];
  };
  summary: { adds: number; updates: number; appends: number; skips: number };
}

export interface AuditContext {
  sessionId: string;
  project: string;
  extractedAt?: string;
}

const LATEST_DIFF = 'memory_diff.json';

export function buildMemoryDiff(ops: MemoryOp[], ctx: AuditContext): MemoryDiff {
  const adds: AddEntry[] = [];
  const updates: UpdateEntry[] = [];
  const appends: AppendEntry[] = [];
  const skips: SkipEntry[] = [];
  for (const op of ops) {
    if (op.op === 'add') adds.push({ uri: op.path, title: op.title, evidence: op.evidence });
    else if (op.op === 'patch') updates.push({ uri: op.path, title: op.title, before: op.before, after: op.content });
    else if (op.op === 'append') appends.push({ uri: op.path });
    else skips.push({ type: op.type, title: op.title, reason: op.reason });
  }
  return {
    session_id: ctx.sessionId,
    project: ctx.project,
    extracted_at: ctx.extractedAt ?? new Date().toISOString(),
    operations: { adds, updates, appends, skips },
    summary: { adds: adds.length, updates: updates.length, appends: appends.length, skips: skips.length },
  };
}

export async function writeMemoryDiff(diff: MemoryDiff, storage: StorageAdapter): Promise<void> {
  const json = JSON.stringify(diff, null, 2);
  await storage.write(LATEST_DIFF, json);
  await storage.write(`audit/${diff.session_id}.json`, json);
}

export async function readLatestDiff(storage: StorageAdapter): Promise<MemoryDiff | null> {
  return readDiffAt(storage, LATEST_DIFF);
}

export async function readSessionDiff(storage: StorageAdapter, sessionId: string): Promise<MemoryDiff | null> {
  return readDiffAt(storage, `audit/${sessionId}.json`);
}

async function readDiffAt(storage: StorageAdapter, path: string): Promise<MemoryDiff | null> {
  const text = await storage.read(path);
  if (text === null) return null;
  return JSON.parse(text) as MemoryDiff;
}

export function formatDiff(diff: MemoryDiff): string {
  const s = diff.summary;
  if (s.adds + s.updates + s.appends + s.skips === 0) return '本次无新增记忆';
  const lines = [`本次新增 ${s.adds} 条、更新 ${s.updates} 条、追加 ${s.appends} 条、跳过 ${s.skips} 条`];
  for (const a of diff.operations.adds) lines.push(`  新增: ${a.title} (${a.uri})`);
  for (const u of diff.operations.updates) lines.push(`  更新: ${u.title} (${u.uri})`);
  for (const a of diff.operations.appends) lines.push(`  追加: ${a.uri}`);
  for (const sk of diff.operations.skips) lines.push(`  跳过: ${sk.title}（${sk.reason}）`);
  return lines.join('\n');
}

/** 阶段 7:把阶段 6 的操作落盘为 .md 文件,并同步 INDEX.md 与 .overview.md。所有写盘统一走 v2 schema。 */
import type { MemoryOp, MemoryMeta } from './merge.js';
import type { StorageAdapter } from './storage.js';
import { appendEvidenceSection, stripEvidenceSection } from './contract.js';
import { INDEX_TEMPLATE } from './layout.js';
import { touchSidecars } from './sidecar.js';
import { newMemoryId, inferKind, idPrefix, parseMemory, renderMemory } from './memory.js';
import type { EvidenceRef, MemoryV2 } from './memory.js';

export interface WriteDeps {
  storage: StorageAdapter;
  /** 可控时钟,便于测试 updated_at 变化;缺省用系统时间。 */
  now?: () => Date;
  /** 记忆来源会话标识(harness:session 或 session id),写入 frontmatter.source。 */
  source?: string;
}

export interface ApplyResult {
  added: string[];
  updated: string[];
  appended: string[];
  archived: string[];
  skipped: string[];
}

const SECTION: Record<string, string> = {
  preferences: 'Preferences',
  entities: 'Entities',
  experiences: 'Experiences',
  events: 'Events',
  resources: 'Resources',
};

export async function applyOperations(ops: MemoryOp[], deps: WriteDeps): Promise<ApplyResult> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const res: ApplyResult = { added: [], updated: [], appended: [], archived: [], skipped: [] };

  for (const op of ops) {
    if (op.op === 'add') {
      await deps.storage.write(op.path, renderV2File(op, now()));
      res.added.push(op.path);
      const archive = op.archivePath ?? op.supersedePath;
      if (archive && archive !== op.path && (await archiveFile(archive, op.path, deps.storage))) {
        res.archived.push(archive);
      }
    } else if (op.op === 'patch') {
      const existing = await deps.storage.read(op.path);
      await deps.storage.write(op.path, renderV2Patch(op, existing, now()));
      res.updated.push(op.path);
    } else if (op.op === 'append') {
      const existing = (await deps.storage.read(op.path)) ?? '';
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      await deps.storage.write(op.path, existing + sep + op.content + '\n');
      res.appended.push(op.path);
    } else {
      res.skipped.push(op.title);
    }
  }

  await updateIndex(ops, deps.storage);
  await touchSidecars(deps.storage, affectedDirs(ops), { trigger: 'memory_write', now: deps.now });
  return res;
}

/** 无 meta 的旧调用方(memo/recent)自动补 v2 meta;有 meta 直接用。 */
function metaOf(op: Extract<MemoryOp, { op: 'add' | 'patch' }>, existing: string | null): MemoryMeta {
  if (op.meta) return op.meta;
  const old = existing ? parseMemory(existing) : null;
  return {
    id: old?.id || newMemoryId(idPrefix(op.type)),
    kind: inferKind(op.type),
    status: 'active',
    version: op.op === 'add' ? 1 : (old?.version ?? 0) + 1,
    evidence: [],
    promptVersion: 'legacy',
  };
}

/** v2 add:用 renderMemory 渲染(含 id/kind/status/version/quality/evidence),仍走 INDEX/sidecar。 */
function renderV2File(op: Extract<MemoryOp, { op: 'add' }>, nowIso: string): string {
  const meta = metaOf(op, null);
  const mem: MemoryV2 = {
    id: meta.id,
    kind: meta.kind,
    type: op.type,
    title: op.title,
    tags: deriveTags(op.type),
    scope: 'global',
    status: meta.status,
    version: meta.version,
    confidence: meta.confidence,
    quality: meta.quality,
    evidence: meta.evidence,
    sourceTrajectories: meta.sourceTrajectories,
    supersedes: meta.supersedes,
    createdAt: nowIso,
    updatedAt: nowIso,
    useCount: 0,
    helpfulCount: 0,
    promptVersion: meta.promptVersion,
    body: v2Body(op.type, op.content, meta.evidence),
  };
  return renderMemory(mem);
}

/** 经验类正文补 `## 证据` 段(先删旧段避免重复);非经验类原样返回。 */
function v2Body(type: string, content: string, evidence: EvidenceRef[]): string {
  if (!type.startsWith('experiences/')) return content;
  return appendEvidenceSection(stripEvidenceSection(content), evidence);
}

/** v2 patch:保留旧 id/created_at,version 递增,证据合并去重。 */
function renderV2Patch(op: Extract<MemoryOp, { op: 'patch' }>, existing: string | null, nowIso: string): string {
  const meta = metaOf(op, existing);
  const old = existing ? parseMemory(existing) : null;
  const evidence = dedupeEvidence([...(old?.evidence ?? []), ...(meta.evidence ?? [])]);
  const mem: MemoryV2 = {
    id: old?.id || meta.id,
    kind: meta.kind,
    type: op.type,
    title: op.title,
    tags: deriveTags(op.type),
    scope: old?.scope ?? 'global',
    status: meta.status,
    version: (old?.version ?? 0) + 1,
    confidence: meta.confidence,
    quality: meta.quality,
    evidence,
    sourceTrajectories: meta.sourceTrajectories,
    supersedes: meta.supersedes,
    createdAt: old?.createdAt || (existing ? (extractField(existing, 'created_at') ?? nowIso) : nowIso),
    updatedAt: nowIso,
    useCount: old?.useCount ?? 0,
    helpfulCount: old?.helpfulCount ?? 0,
    promptVersion: meta.promptVersion,
    pinned: old?.pinned,
    body: v2Body(op.type, op.content, evidence),
  };
  return renderMemory(mem);
}

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.session}:${r.seq}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function deriveTags(type: string): string[] {
  return type.split('/');
}

function deriveSummary(content: string): string {
  const first = content.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

async function archiveFile(oldPath: string, newPath: string, storage: StorageAdapter): Promise<boolean> {
  const oldText = await storage.read(oldPath);
  if (oldText === null) return false;
  await storage.write(`archive/${oldPath}`, withSupersededBy(oldText, newPath));
  await storage.delete(oldPath);
  return true;
}

function withSupersededBy(text: string, newPath: string): string {
  const closing = text.indexOf('\n---');
  if (closing === -1) return text;
  const front = text.slice(0, closing);
  const back = text.slice(closing);
  const line = `\nsuperseded_by: ${JSON.stringify(newPath)}`;
  // v2 归档同时把 status 改为 superseded;只在 frontmatter 块内替换,不误改正文 status: 行。
  return front.replace(/^status: .*$/m, 'status: superseded') + line + back;
}

function extractField(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}: (.+)$`, 'm'));
  if (!m) return undefined;
  const raw = m[1]!.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function updateIndex(ops: MemoryOp[], storage: StorageAdapter): Promise<void> {
  let text = (await storage.read('INDEX.md')) ?? INDEX_TEMPLATE;
  for (const op of ops) {
    if (op.op === 'add') {
      const archive = op.archivePath ?? op.supersedePath;
      if (archive) text = removeIndexRow(text, archive);
      text = addIndexRow(text, op);
    } else if (op.op === 'patch') {
      text = patchIndexRow(text, op);
    }
    // append / skip 不进 INDEX
  }
  await storage.write('INDEX.md', text);
}

function indexRow(o: { type: string; title: string; path: string; content: string }): string {
  return `- ${o.title} — ${deriveSummary(o.content)} (${o.path}) · tags: ${deriveTags(o.type).join(', ')}`;
}

function addIndexRow(text: string, o: { type: string; title: string; path: string; content: string }): string {
  const section = SECTION[o.type.split('/')[0]!];
  if (!section) return text;
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l === `## ${section}`);
  if (idx === -1) return text;
  lines.splice(idx + 1, 0, indexRow(o));
  return lines.join('\n');
}

/** 从 INDEX.md 移除指定路径的行(归档/忘掉时用)。 */
export async function removeIndexEntry(storage: StorageAdapter, path: string): Promise<void> {
  const text = (await storage.read('INDEX.md')) ?? '';
  await storage.write('INDEX.md', removeIndexRow(text, path));
}

/** 在 INDEX.md 补一行(恢复记忆时用);INDEX.md 不存在时按模板建。 */
export async function addIndexEntry(
  storage: StorageAdapter,
  o: { type: string; title: string; path: string; content: string },
): Promise<void> {
  const text = (await storage.read('INDEX.md')) ?? INDEX_TEMPLATE;
  await storage.write('INDEX.md', addIndexRow(text, o));
}

function patchIndexRow(text: string, o: { type: string; title: string; path: string; content: string }): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(`(${o.path})`));
  if (i === -1) return addIndexRow(text, o);
  lines[i] = indexRow(o);
  return lines.join('\n');
}

function removeIndexRow(text: string, path: string): string {
  return text.split('\n').filter((l) => !l.includes(`(${path})`)).join('\n');
}

/** 本次写入涉及的顶层目录(根 + 各类目),用于触发对应 sidecar 的脏标记与刷新。 */
function affectedDirs(ops: MemoryOp[]): string[] {
  const dirs = new Set<string>(['']);
  for (const op of ops) {
    if (op.op === 'add' || op.op === 'patch' || op.op === 'append') {
      const top = op.type.split('/')[0];
      if (top) dirs.add(top);
    }
  }
  return [...dirs];
}

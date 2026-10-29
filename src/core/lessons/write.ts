/** 阶段 7:把阶段 6 的操作落盘为 .md 文件,并同步 INDEX.md 与 .overview.md。 */
import type { MemoryOp } from './merge.js';
import type { StorageAdapter } from './storage.js';
import { renderFrontmatter } from './frontmatter.js';
import { INDEX_TEMPLATE } from './layout.js';
import { touchSidecars } from './sidecar.js';

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
      await deps.storage.write(op.path, renderFile(op.type, op.title, op.content, { createdAt: now(), updatedAt: now() }, deps.source));
      res.added.push(op.path);
      if (op.supersedePath && (await archiveFile(op.supersedePath, op.path, deps.storage))) {
        res.archived.push(op.supersedePath);
      }
    } else if (op.op === 'patch') {
      const existing = await deps.storage.read(op.path);
      const createdAt = existing ? (extractField(existing, 'created_at') ?? now()) : now();
      await deps.storage.write(op.path, renderFile(op.type, op.title, op.content, { createdAt, updatedAt: now() }, deps.source));
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

function renderFile(type: string, title: string, content: string, o: { createdAt: string; updatedAt: string }, source?: string): string {
  return renderFrontmatter({ type, title, tags: deriveTags(type), createdAt: o.createdAt, updatedAt: o.updatedAt, source }) + '\n' + content + '\n';
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
  const line = `\nsuperseded_by: ${JSON.stringify(newPath)}`;
  return text.slice(0, closing) + line + text.slice(closing);
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
      if (op.supersedePath) text = removeIndexRow(text, op.supersedePath);
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

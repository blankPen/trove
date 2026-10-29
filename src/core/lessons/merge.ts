/** 阶段 6:合并与冲突处理。把候选记忆与现有记忆比对,产出 add/patch/append/skip 四种操作。 */
import type { MemoryCandidate } from './extract.js';
import type { LlmProvider } from './llm.js';
import { buildFilename, getMemoryType } from './schema.js';

export interface ExistingMemory {
  type: string;
  path: string;
  title: string;
  content: string;
}

export type MemoryOp =
  | { op: 'add'; type: string; path: string; title: string; content: string; supersedePath?: string; evidence: number[] }
  | { op: 'patch'; type: string; path: string; title: string; content: string; before: string }
  | { op: 'append'; type: string; path: string; content: string }
  | { op: 'skip'; type: string; title: string; reason: string };

export interface MergeDeps {
  llm: LlmProvider;
}

const TITLE_MIN = 10;

export async function mergeMemories(
  candidates: MemoryCandidate[],
  existing: ExistingMemory[],
  deps: MergeDeps,
): Promise<MemoryOp[]> {
  const ops: MemoryOp[] = [];
  for (const c of candidates) {
    const op = await resolve(c, existing, deps);
    if (op) ops.push(op);
  }
  return ops;
}

async function resolve(c: MemoryCandidate, existing: ExistingMemory[], deps: MergeDeps): Promise<MemoryOp | null> {
  const title = c.title.trim();
  if (title.length < TITLE_MIN) return { op: 'skip', type: c.type, title, reason: 'title_too_short' };
  const schema = getMemoryType(c.type);
  if (!schema) return { op: 'skip', type: c.type, title, reason: 'unknown_type' };
  const path = buildFilename(schema, { title, slug: c.slug });
  const sameType = existing.filter((e) => e.type === c.type);
  const samePath = sameType.find((e) => e.path === path);

  if (schema.mergeOp === 'append') {
    if (samePath) {
      // 幂等:相同正文已存在则跳过,不重复追加(重跑/重复学习不翻倍)
      if (samePath.content.includes(c.content.trim())) return null;
      return { op: 'append', type: c.type, path, content: c.content };
    }
    return { op: 'add', type: c.type, path, title, content: c.content, evidence: c.evidence };
  }
  if (schema.mergeOp === 'patch') {
    if (samePath) {
      const merged = await mergeContent(c, samePath, deps.llm);
      return { op: 'patch', type: c.type, path, title, content: merged, before: samePath.content };
    }
    return { op: 'add', type: c.type, path, title, content: c.content, evidence: c.evidence };
  }
  // mergeOp === 'add':每条独立新建;仅结论冲突时归档旧记忆。
  if (samePath) return null; // 同类型同路径 = 重复记忆,幂等跳过(重跑不翻倍)
  if (sameType.length > 0) {
    const conflict = await detectConflict(c, sameType, deps.llm);
    if (conflict) return { op: 'add', type: c.type, path, title, content: c.content, supersedePath: conflict.path, evidence: c.evidence };
  }
  return { op: 'add', type: c.type, path, title, content: c.content, evidence: c.evidence };
}

const MERGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
};

async function mergeContent(c: MemoryCandidate, existing: ExistingMemory, llm: LlmProvider): Promise<string> {
  const prompt = (getMemoryType(c.type)?.mergePrompt ?? '')
    .replace('{summary}', `标题:${c.title}\n正文:${c.content}`)
    .replace('{existing}', existing.content);
  const raw = await llm.generate<{ content?: unknown }>(prompt, MERGE_SCHEMA);
  return typeof raw?.content === 'string' ? raw.content : c.content;
}

const CONFLICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { conflict: { type: 'boolean' }, path: { type: 'string' } },
  required: ['conflict'],
};

async function detectConflict(c: MemoryCandidate, sameType: ExistingMemory[], llm: LlmProvider): Promise<ExistingMemory | null> {
  const prompt = [
    `判断新记忆是否与现有记忆结论冲突。`,
    `新记忆:标题:${c.title}\n正文:${c.content}`,
    '现有记忆:',
    sameType.map((e) => `- ${e.path}: ${e.content}`).join('\n'),
  ].join('\n');
  const raw = await llm.generate<{ conflict?: unknown; path?: unknown }>(prompt, CONFLICT_SCHEMA);
  if (raw?.conflict !== true) return null;
  const p = typeof raw.path === 'string' ? raw.path : undefined;
  const matched = p ? sameType.find((e) => e.path === p) : undefined;
  return matched ?? sameType[0] ?? null;
}

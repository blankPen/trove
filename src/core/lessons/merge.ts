/** 阶段 6:合并与冲突处理。把候选记忆与现有记忆比对,产出 add/patch/append/skip 四种操作。 */
import type { MemoryCandidate, MemoryCandidateV2 } from './extract.js';
import type { LlmProvider } from './llm.js';
import { buildFilename, getMemoryType, slugify } from './schema.js';
import type { LearnConfig } from '../../config.js';
import type { DecisionGateway, CandidateForGate, ExistingForGate } from './gateway.js';
import type { EvidenceRef, MemoryKind, MemoryStatus, QualityScore } from './memory.js';
import { idPrefix, inferKind, newMemoryId } from './memory.js';

export interface ExistingMemory {
  type: string;
  path: string;
  title: string;
  content: string;
}

/** v2 写入附带的新 schema 字段;无 meta 的 op 走 v1 老逻辑。 */
export interface MemoryMeta {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  version: number;
  quality?: QualityScore;
  evidence: EvidenceRef[];
  sourceTrajectories?: string[];
  supersedes?: string;
  promptVersion?: string;
  confidence?: number;
  scope?: string;
}

export type MemoryOp =
  | { op: 'add'; type: string; path: string; title: string; content: string; supersedePath?: string; archivePath?: string; evidence: number[]; meta?: MemoryMeta }
  | { op: 'patch'; type: string; path: string; title: string; content: string; before: string; meta?: MemoryMeta }
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
  const raw = await llm.generate<{ content?: unknown }>(prompt, MERGE_SCHEMA, 'learn:merge');
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
  const raw = await llm.generate<{ conflict?: unknown; path?: unknown }>(prompt, CONFLICT_SCHEMA, 'learn:conflict');
  if (raw?.conflict !== true) return null;
  const p = typeof raw.path === 'string' ? raw.path : undefined;
  const matched = p ? sameType.find((e) => e.path === p) : undefined;
  return matched ?? sameType[0] ?? null;
}

// ── v2 合并:Gate C 身份裁决 → add/merge/supersede,附 meta ──

export interface V2MergeDeps {
  gateway: DecisionGateway;
  llm: LlmProvider;
  learn: LearnConfig;
}

export async function mergeMemoriesV2(
  candidates: MemoryCandidateV2[],
  existing: ExistingForGate[],
  deps: V2MergeDeps,
): Promise<MemoryOp[]> {
  const ops: MemoryOp[] = [];
  for (const c of candidates) {
    const op = await resolveV2(c, existing, deps);
    if (op) ops.push(op);
  }
  return ops;
}

async function resolveV2(c: MemoryCandidateV2, existing: ExistingForGate[], deps: V2MergeDeps): Promise<MemoryOp | null> {
  const gate: CandidateForGate = { type: c.type, title: c.title, content: c.content, evidence: c.evidence };
  const top = topSimilar(gate, c.scope, existing);
  let identity = await deps.gateway.resolveIdentity(gate, top);
  if (identity.decision === 'escalate') {
    // 边界带交 LLM 身份裁决;失败回退 add(非破坏性)
    const d = await llmIdentityDecision(c, top, deps.llm);
    identity = { ...identity, decision: d, targetPath: top[0]?.path, targetId: top[0]?.id };
  }

  const schema = getMemoryType(c.type);
  const path = schema ? buildFilename(schema, { title: c.title, slug: c.slug }) : `${c.type.split('/')[0]}/${slugify(c.title)}.md`;
  const meta: MemoryMeta = {
    id: newMemoryId(idPrefix(c.type)),
    kind: inferKind(c.type),
    status: 'active',
    version: 1,
    evidence: c.evidence,
    quality: c.quality,
    sourceTrajectories: c.sourceTrajectories,
    promptVersion: 'exp-v3',
    confidence: c.confidence ?? identity.confidence,
    ...(c.scope ? { scope: c.scope } : {}),
  };

  // 同路径已存在时不新增覆盖:append 追加 / patch 合并 / add 幂等跳过(v1 口径)。
  const samePath = existing.find((e) => e.path === path);
  if (samePath) {
    if (schema?.mergeOp === 'append') {
      if (samePath.content.includes(c.content.trim())) return null;
      return { op: 'append', type: c.type, path, content: c.content };
    }
    if (schema?.mergeOp === 'patch') {
      const content = await mergeContentV2(c, samePath, deps.llm);
      return { op: 'patch', type: c.type, path, title: c.title, content, before: samePath.content, meta };
    }
    if (schema?.mergeOp === 'add') return null;
  }

  if (identity.decision === 'merge' && identity.targetPath) {
    const target = existing.find((e) => e.path === identity.targetPath) ?? top[0];
    const content = await mergeContentV2(c, target, deps.llm);
    return { op: 'patch', type: c.type, path: identity.targetPath, title: c.title, content, before: target?.content ?? '', meta };
  }
  if (identity.decision === 'supersede') {
    return { op: 'add', type: c.type, path, title: c.title, content: c.content, evidence: c.evidence.map((e) => e.seq), archivePath: identity.targetPath, meta: { ...meta, supersedes: identity.targetId ?? identity.targetPath } };
  }
  return { op: 'add', type: c.type, path, title: c.title, content: c.content, evidence: c.evidence.map((e) => e.seq), meta };
}

const IDENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { decision: { type: 'string', enum: ['add', 'merge', 'supersede'] }, reason: { type: 'string' } },
  required: ['decision'],
};

async function llmIdentityDecision(c: MemoryCandidateV2, top: ExistingForGate[], llm: LlmProvider): Promise<'add' | 'merge' | 'supersede'> {
  try {
    const raw = await llm.generate<{ decision?: unknown }>(
      [`判断新记忆与现有记忆的关系:add(新增)/merge(合并进现有)/supersede(取代现有)。`,
        `新记忆:标题:${c.title}\n正文:${c.content}`,
        '现有记忆:',
        top.map((e) => `- ${e.path}: ${e.content}`).join('\n')].join('\n'),
      IDENTITY_SCHEMA,
      'learn:identity',
    );
    return raw?.decision === 'merge' || raw?.decision === 'supersede' ? raw.decision : 'add';
  } catch {
    return 'add';
  }
}

const V2_MERGE_PROMPT = `把新提取的记忆合并进现有记忆,输出完整合并后的正文:保留旧的有效事实、补入新内容、去重、不丢证据;经验类保持五段式(## 适用场景 / ## 做法 / ## 验证 / ## 边界与反例)。新:{summary}\n现有:{existing}`;

async function mergeContentV2(c: MemoryCandidateV2, existing: ExistingForGate | undefined, llm: LlmProvider): Promise<string> {
  const template = c.type.startsWith('experiences/') ? V2_MERGE_PROMPT : (getMemoryType(c.type)?.mergePrompt ?? '');
  if (!template) return c.content;
  const prompt = template.replace('{summary}', `标题:${c.title}\n正文:${c.content}`).replace('{existing}', existing?.content ?? '');
  const raw = await llm.generate<{ content?: unknown }>(prompt, MERGE_SCHEMA, 'learn:merge');
  return typeof raw?.content === 'string' ? raw.content : c.content;
}

/** 同 type 且 scope 兼容(相同或任一方 global)的旧记忆按标题字符 2-gram 交集(Dice)打分取前 5。 */
function topSimilar(c: CandidateForGate, scope: string | undefined, existing: ExistingForGate[]): ExistingForGate[] {
  return existing
    .filter((e) => e.type === c.type && scopeCompatible(scope, e.scope))
    .map((e) => ({ e, score: titleScore(c.title, e.title) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.e);
}

/** scope 兼容:相同,或任一方缺失/global(旧 global 可被任意项目合并)。 */
function scopeCompatible(a: string | undefined, b: string | undefined): boolean {
  const A = a ?? 'global';
  const B = b ?? 'global';
  return A === B || A === 'global' || B === 'global';
}

function titleScore(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function bigrams(s: string): Set<string> {
  const chars = [...s];
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

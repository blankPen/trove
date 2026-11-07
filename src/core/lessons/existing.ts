/** 现有记忆回读与相关记忆挑选:只认带合法 frontmatter 的文件,忽略审计/归档/元数据。 */
import type { Event } from '../events/schema.js';
import type { QualityScore } from './memory.js';
import type { StorageAdapter } from './storage.js';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';
import { parseMemory } from './memory.js';
import { projectSlug } from './scope.js';
import { bigrams, dice } from './similarity.js';

/** 非记忆文件(元数据/审计),不参与合并。 */
const NON_MEMORY = new Set(['INDEX.md', '.overview.md', 'memory_diff.json', 'README.md']);
const SKIP_PREFIXES = ['archive/', 'audit/', 'trajectories/', '.trove/'];

/** 现有记忆:内容相关字段必填,记忆元信息按文件实际存在与否可选。 */
export interface ExistingMemory {
  type: string;
  path: string;
  title: string;
  content: string;
  id?: string;
  scope?: string;
  quality?: QualityScore;
  useCount?: number;
}

function isMemoryPath(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return false;
  return !NON_MEMORY.has(path);
}

export async function loadExistingMemories(storage: StorageAdapter): Promise<ExistingMemory[]> {
  const files = await storage.list();
  const out: ExistingMemory[] = [];
  for (const path of files) {
    if (!isMemoryPath(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    out.push({ type: fm.type, path, title: fm.title, content: (stripFrontmatter(text) ?? '').trim() });
  }
  return out;
}

/** 分析前回读:带 id/scope/quality 等元信息(parseMemory 对 v1 文件也回退补默认)。 */
export async function loadExistingForGate(storage: StorageAdapter): Promise<ExistingMemory[]> {
  const files = await storage.list();
  const out: ExistingMemory[] = [];
  for (const path of files) {
    if (!isMemoryPath(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const mem = parseMemory(text);
    if (!mem) continue;
    out.push({
      id: mem.id || undefined,
      path,
      title: mem.title,
      content: mem.body.trim(),
      type: mem.type,
      scope: mem.scope,
      ...(mem.quality ? { quality: mem.quality } : {}),
      useCount: mem.useCount,
    });
  }
  return out;
}

export interface RelatedOptions {
  /** 最多注入多少条完整正文。 */
  topK?: number;
  /** 同一 type 最多几条,保证类别多样性。 */
  perTypeCap?: number;
}

export interface RelatedMemory extends ExistingMemory {
  score: number;
}

/**
 * 挑选与本次会话相关的现有记忆(纯词法,不调模型):
 * 命中分数高者优先,固定偏好文件强制注入,便于模型判断该 patch 哪条。
 */
export function selectRelatedMemories(
  events: Event[],
  existing: ExistingMemory[],
  project: string,
  opts: RelatedOptions = {},
): RelatedMemory[] {
  const topK = opts.topK ?? 8;
  const perTypeCap = opts.perTypeCap ?? 3;
  const query = buildQuery(events);
  const scored = existing
    .filter((m) => scopeCompatible(project, m.scope))
    .map((m) => ({ ...m, score: scoreMemory(query, m) }))
    .sort((a, b) => b.score - a.score);

  const out: RelatedMemory[] = [];
  const byType = new Map<string, number>();
  for (const m of scored) {
    const n = byType.get(m.type) ?? 0;
    if (n >= perTypeCap) continue;
    byType.set(m.type, n + 1);
    out.push(m);
    if (out.length >= topK) break;
  }
  // 固定路径的偏好/画像文件永远注入:模型想 patch 时必须能看到全文。
  for (const m of existing) {
    if (!m.path.startsWith('preferences/')) continue;
    if (out.some((x) => x.path === m.path)) continue;
    out.push({ ...m, score: 0 });
  }
  return out;
}

/** 查询包:最近若干条 user 文本 + 错误输出 + 工具名,截断到 6000 字符。 */
function buildQuery(events: Event[]): Set<string> {
  const parts: string[] = [];
  for (const e of events) {
    if (e.kind === 'message' && e.role === 'user' && e.text) parts.push(e.text);
    else if (e.kind === 'tool_result' && e.result?.status === 'error' && typeof e.result.output === 'string') {
      parts.push(e.result.output.slice(0, 500));
    } else if (e.kind === 'tool_call' && e.tool?.name) parts.push(e.tool.name);
  }
  return bigrams(parts.join(' ').slice(0, 6000));
}

function scoreMemory(query: Set<string>, m: ExistingMemory): number {
  const title = dice(query, bigrams(m.title));
  const body = dice(query, bigrams(m.content.slice(0, 800)));
  const usage = Math.min(1, Math.log1p(m.useCount ?? 0) / Math.log(11));
  return 0.6 * title + 0.3 * body + 0.1 * usage;
}

function scopeCompatible(project: string, scope?: string): boolean {
  const target = scope ?? 'global';
  return target === 'global' || target === `project:${projectSlug(project)}`;
}

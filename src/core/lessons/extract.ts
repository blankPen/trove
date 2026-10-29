/** 阶段 5:五类记忆提取器。按分类结果只跑为真的类别,产出带 evidence 的候选记忆;敏感信息与空候选在此过滤。 */
import type { Event } from '../events/schema.js';
import type { LlmProvider } from './llm.js';
import type { Classification, SessionSummary } from './analyze.js';
import { renderEvents } from './analyze.js';
import { getMemoryType } from './schema.js';

export interface MemoryCandidate {
  /** 记忆类型 key,如 `experiences/debug_pattern`。 */
  type: string;
  title: string;
  content: string;
  slug?: string;
  /** 来源事件 seq,必须落在输入事件范围内。 */
  evidence: number[];
}

export interface ExtractDeps {
  llm: LlmProvider;
  /** 已有记忆的渲染文本,供提取器去重参考;缺省为空。 */
  existing?: string;
}

const TYPES_BY_CATEGORY: Record<keyof Classification, string[]> = {
  preferences: ['preferences/profile', 'preferences/coding_style', 'preferences/writing_style', 'preferences/dialogue_style', 'preferences/recent_matters'],
  entities: ['entities/project', 'entities/people', 'entities/organization', 'entities/tool', 'entities/tech'],
  experiences: ['experiences/debug_pattern', 'experiences/workflow', 'experiences/gotcha', 'experiences/correction'],
  events: ['events/decision'],
  resources: ['resources/doc', 'resources/repo', 'resources/link'],
};

const CATEGORY_LABEL: Record<keyof Classification, string> = {
  preferences: '偏好',
  entities: '实体',
  experiences: '经验',
  events: '决策',
  resources: '资源',
};

const CANDIDATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string', description: '记忆正文,用结构化 Markdown 输出:1~3 个 `##` 小节(按内容自然分段),每节 1~3 条 `-` 要点,不要整段纯文本。' },
          slug: { type: 'string' },
          evidence: { type: 'array', items: { type: 'integer' } },
        },
        required: ['type', 'title', 'content', 'evidence'],
      },
    },
  },
  required: ['memories'],
};

/** 只跑分类为真的提取器,汇总各自候选。 */
export async function extractMemories(
  summary: SessionSummary,
  classification: Classification,
  events: Event[],
  deps: ExtractDeps,
): Promise<MemoryCandidate[]> {
  const out: MemoryCandidate[] = [];
  for (const category of Object.keys(TYPES_BY_CATEGORY) as (keyof Classification)[]) {
    if (!classification[category]) continue;
    out.push(...(await extractCategory(category, summary, events, deps)));
  }
  return out;
}

async function extractCategory(
  category: keyof Classification,
  summary: SessionSummary,
  events: Event[],
  deps: ExtractDeps,
): Promise<MemoryCandidate[]> {
  const allowed = TYPES_BY_CATEGORY[category];
  const prompt = [
    `从会话中提取「${CATEGORY_LABEL[category]}」类记忆,type 只能是:${allowed.join('、')}。`,
    '每条记忆的 content 用结构化 Markdown 输出:1~3 个 `##` 小节(如背景/要点/结论),每节 1~3 条 `-` 要点;不要输出一整段纯文本。',
    ...(category === 'preferences'
      ? ['各 type 提取口径:', ...allowed.map((t) => `- ${t}: ${getMemoryType(t)?.extractionPrompt ?? ''}`)]
      : []),
    ...(category === 'resources'
      ? ['资源类记忆的 content 必须包含来源:URL(http/https)或文件路径(事件里的 @path:line),做到完全可溯源。']
      : []),
    `摘要:${JSON.stringify(summary)}`,
    '事件:',
    renderEvents(events),
    ...(deps.existing ? [`已有记忆(避免重复提取):${deps.existing}`] : []),
  ].join('\n');
  const raw = await deps.llm.generate<{ memories?: unknown }>(prompt, CANDIDATE_SCHEMA);
  const list = Array.isArray(raw?.memories) ? raw.memories : [];
  const validTypes = new Set(allowed);
  const seqs = new Set(events.map((e) => e.seq));
  const out: MemoryCandidate[] = [];
  for (const item of list) {
    const c = parseCandidate(item, validTypes, seqs);
    if (c) out.push(c);
  }
  return out;
}

function parseCandidate(raw: unknown, validTypes: Set<string>, seqs: Set<number>): MemoryCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? '');
  if (!validTypes.has(type)) return null;
  const title = scrubSecrets(String(r.title ?? '').trim());
  const content = scrubSecrets(String(r.content ?? '').trim());
  if (!title || !content) return null;
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.map((n) => Number(n)).filter((n) => Number.isInteger(n) && seqs.has(n))
    : [];
  if (evidence.length === 0) return null;
  const slug = typeof r.slug === 'string' && r.slug.trim() ? r.slug : undefined;
  return { type, title, content, slug, evidence };
}

// shortcut: 敏感值抹除走关键词正则,覆盖常见密钥形态;命中即整段替换为 [REDACTED]。
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*["']?[^\s"'`,;]+["']?/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

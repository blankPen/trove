/** 单次结构化分析:一次 LLM 调用同时完成提取、去重与合并决策,输出符合 trove schema 的 ops。 */
import type { Event } from '../events/schema.js';
import type { LlmProvider } from './llm.js';
import type { MemoryOp, MemoryMeta } from './merge.js';
import type { ExistingMemory, RelatedMemory } from './existing.js';
import type { EvidenceRef } from './memory.js';
import { buildFilename, getMemoryType, listMemoryTypes } from './schema.js';
import { scrubSecrets } from './secrets.js';
import { verifyEvidence } from './evidence.js';
import { inferScope } from './scope.js';
import { lintExperience } from './contract.js';
import { idPrefix, inferKind, newMemoryId } from './memory.js';

export const OPS_TASK = 'learn:extract-ops';
/** 单次最多接受的 op 数,防止输出超模型上限被截断。 */
export const MAX_OPS = 10;
const TITLE_MIN = 10;
const CONTENT_MAX = 1200;

export interface RawOp {
  action: 'add' | 'patch' | 'append' | 'skip';
  type: string;
  title?: string;
  /** 文件 slug:小写英文短横线,add 时用于生成稳定路径。 */
  slug?: string;
  content?: string;
  /** patch/append 必填:现有记忆路径,只能从注入的相关记忆里选。 */
  target?: string;
  /** patch 必填:现有正文中连续出现的锚点片段。 */
  before?: string;
  evidence?: Array<{ seq: number; quote: string }>;
  reason?: string;
}

export interface OpsContext {
  session: string;
  project: string;
  /** 压缩后的事件,用于证据定位。 */
  events: Event[];
  existing: ExistingMemory[];
  related: RelatedMemory[];
}

const OPS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'patch', 'append', 'skip'] },
          type: { type: 'string' },
          title: { type: 'string' },
          slug: { type: 'string' },
          content: { type: 'string' },
          target: { type: 'string' },
          before: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: { seq: { type: 'number' }, quote: { type: 'string' } },
              required: ['seq', 'quote'],
            },
          },
          reason: { type: 'string' },
        },
        required: ['action', 'type'],
      },
    },
  },
  required: ['ops'],
};

/** 与 Hermes 的 do-not-capture 规则同源:这些内容写进去会变成长期自我限制。 */
const DO_NOT_CAPTURE = [
  '环境依赖的临时失败(命令找不到、未安装、路径不对、凭证未配置)',
  '"X 工具不能用"这类负面断言——问题修好后它会变成长期拒绝理由',
  '会话结束前已经解决的重试型瞬时错误',
  '一次性的任务叙述(帮我看看某个 PR、总结今天的行情)',
  '没有验证成功的尝试序列——禁止把死路写成推荐做法',
  '环境、仓库、工具 schema 里已经写明的东西',
  '会话中没有真实出现的信息(禁止推断用户画像)',
].map((s) => `- ${s}`).join('\n');

export function buildOpsPrompt(ctx: OpsContext): string {
  const types = listMemoryTypes().filter((t) => t.key !== 'preferences/recent_matters');
  const typeLines = types.map((t) => `- ${t.key}: ${t.extractionPrompt}`).join('\n');
  const experienceTypes = types.filter((t) => t.key.startsWith('experiences/')).map((t) => t.key);

  const relatedBlock = ctx.related.length
    ? ctx.related.map((m) => `### ${m.path} · ${m.title}\n${m.content.slice(0, 800)}`).join('\n\n')
    : '(无)';
  const relatedPaths = new Set(ctx.related.map((m) => m.path));
  const indexLines = ctx.existing
    .filter((m) => !relatedPaths.has(m.path))
    .slice(0, 300)
    .map((m) => `- ${m.path} · ${m.title}`)
    .join('\n');

  return [
    '你是 trove 的经验沉淀器。阅读下面的会话,提取值得跨会话复用的记忆,并决定写入方式。',
    '',
    '## 什么该记',
    '- 用户明确的偏好、纠正、长期要求("以后都这样""别再用 X")',
    '- 非平凡的技术方案、命令、配置、踩过的坑',
    '- 项目、人物、工具、技术栈的稳定事实',
    '- 用户拍板的决策与结论',
    '',
    '## 什么不该记(硬规则)',
    DO_NOT_CAPTURE,
    '',
    '## 记忆类型(type 必须严格取下列之一)',
    typeLines,
    '',
    `经验类(${experienceTypes.join(' / ')})的 content 必须按「## 适用场景 / ## 做法 / ## 验证 / ## 边界与反例」四段写,不要写「## 证据」段——流水线会自动追加。`,
    '',
    '## 写入规则',
    '1. 优先 patch 已有记忆,不要新建重复条目;同一条经验只写一次。',
    '2. action 含义:',
    '   - add:新建记忆,必须给 title + content + evidence',
    '   - patch:改写已有记忆,必须给 target(现有路径)+ before(现有正文中连续 ≥20 字)+ title + content',
    '   - append:向已有资源类记忆追加内容,必须给 target + content',
    '   - skip:明确判断不该记,给 reason',
    '3. target 只能从下面「相关记忆」的路径中选择;选不到合适的就 add。',
    '4. evidence 必须来自会话原文:quote 是事件文本里连续 ≥12 字的片段,seq 是该事件开头的 [序号]。',
    '5. 正文控制在 700 字以内;只写有证据支撑的内容。',
    '6. add 时给 slug(小写英文短横线,≤32 字符,如 set-e-retry),用于生成稳定文件名。',
    `7. 最多输出 ${MAX_OPS} 条,按价值从高到低排序。`,
    '',
    '## 相关记忆(完整正文,优先 patch 这些)',
    relatedBlock,
    '',
    '## 其余记忆索引(只有路径与标题)',
    indexLines || '(无)',
    '',
    '## 会话',
    renderCompactEvents(ctx.events),
    '',
    '## 输出',
    '只返回 JSON:{"ops":[{action,type,title,content,target,before,evidence:[{seq,quote}],reason}]}',
  ].join('\n');
}

/** 与 renderEvents 同格式,但只保留 [seq] kind: text,供 prompt 与证据 seq 对齐。 */
function renderCompactEvents(events: Event[]): string {
  return events
    .map((e) => {
      const text = e.text ?? (typeof e.result?.output === 'string' ? e.result.output : '');
      const kind = e.kind === 'tool_result' && e.result?.status === 'error' ? 'error' : e.kind;
      return `[${e.seq}] ${kind}${text ? `: ${text}` : ''}`;
    })
    .join('\n');
}

export async function analyzeOps(
  ctx: OpsContext,
  llm: LlmProvider,
): Promise<{ raw: RawOp[]; rejected: Array<{ type: string; title: string; reason: string }>; ops: MemoryOp[] }> {
  const prompt = buildOpsPrompt(ctx);
  const out = await llm.generate<unknown>(prompt, OPS_SCHEMA, OPS_TASK);
  const raw = parseRawOps(out);
  const { ops, rejected } = validateOps(raw, ctx);
  return { raw, ops, rejected };
}

/** 宽松解析:只认结构正确的 op,其余丢弃(不因个别字段缺失让整次分析失败)。 */
export function parseRawOps(raw: unknown): RawOp[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const arr = (raw as { ops?: unknown }).ops;
  if (!Array.isArray(arr)) return [];
  const out: RawOp[] = [];
  for (const item of arr.slice(0, MAX_OPS)) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const action = o.action;
    if (action !== 'add' && action !== 'patch' && action !== 'append' && action !== 'skip') continue;
    if (typeof o.type !== 'string') continue;
    const evidence: RawOp['evidence'] = Array.isArray(o.evidence)
      ? o.evidence
          .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
          .map((e) => ({ seq: Number(e.seq), quote: String(e.quote ?? '') }))
          .filter((e) => Number.isInteger(e.seq) && e.quote.length > 0)
      : undefined;
    out.push({
      action,
      type: o.type,
      ...(typeof o.title === 'string' ? { title: o.title } : {}),
      ...(typeof o.slug === 'string' ? { slug: o.slug } : {}),
      ...(typeof o.content === 'string' ? { content: o.content } : {}),
      ...(typeof o.target === 'string' ? { target: o.target } : {}),
      ...(typeof o.before === 'string' ? { before: o.before } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
      ...(evidence ? { evidence } : {}),
    });
  }
  return out;
}

export interface ValidateResult {
  ops: MemoryOp[];
  rejected: Array<{ type: string; title: string; reason: string }>;
}

/** 确定性校验:类型/标题/证据/锚点/路径,任一不过就转 skip,绝不写出半条记忆。 */
export function validateOps(raw: RawOp[], ctx: OpsContext): ValidateResult {
  const ops: MemoryOp[] = [];
  const rejected: Array<{ type: string; title: string; reason: string }> = [];
  const existingByPath = new Map(ctx.existing.map((m) => [m.path, m]));
  const allowedTargets = new Set(ctx.related.map((m) => m.path));
  const seenTitles = new Set<string>();
  const reject = (type: string, title: string, reason: string): void => {
    rejected.push({ type, title, reason });
  };

  for (const op of raw) {
    const schema = getMemoryType(op.type);
    const title = (op.title ?? '').trim();
    if (!schema) {
      reject(op.type, title || op.type, 'unknown_type');
      continue;
    }
    if (op.action === 'skip') {
      ops.push({ op: 'skip', type: op.type, title: title || op.type, reason: op.reason ?? 'model_skip' });
      continue;
    }
    if (title.length < TITLE_MIN) {
      reject(op.type, title, 'title_too_short');
      continue;
    }
    const content = scrubSecrets((op.content ?? '').trim());
    if (!content) {
      reject(op.type, title, 'empty_content');
      continue;
    }
    if (content.length > CONTENT_MAX) {
      reject(op.type, title, 'content_too_long');
      continue;
    }
    if (seenTitles.has(`${op.type}:${title}`)) {
      reject(op.type, title, 'duplicate_title');
      continue;
    }

    const evidence = verifyEvidence(ctx.session, op.evidence ?? [], ctx.events);
    if (op.action !== 'append' && !evidence.ok) {
      reject(op.type, title, 'evidence_missing');
      continue;
    }
    if (op.content && schema.extractionPrompt && op.type.startsWith('experiences/')) {
      const findings = lintExperience({ type: op.type, content, evidence: evidence.refs });
      if (findings.length > 0) {
        reject(op.type, title, `lint:${findings[0]!.code ?? 'experience_format'}`);
        continue;
      }
    }

    const scope = inferScope(op.type, ctx.project);
    const path = buildFilename(schema, { title, slug: op.slug });

    if (op.action === 'add') {
      if (existingByPath.has(path)) {
        // 同路径已存在:模型没选 patch,按幂等跳过,不覆盖。
        reject(op.type, title, 'add_path_collision');
        continue;
      }
      seenTitles.add(`${op.type}:${title}`);
      ops.push({
        op: 'add',
        type: op.type,
        path,
        title,
        content,
        evidence: evidence.refs.map((r) => r.seq),
        meta: metaOf(op.type, scope, evidence.refs),
      });
      continue;
    }

    const target = op.target?.trim();
    if (!target) {
      reject(op.type, title, 'target_missing');
      continue;
    }
    if (!allowedTargets.has(target)) {
      reject(op.type, title, 'target_not_in_context');
      continue;
    }
    const existing = existingByPath.get(target);
    if (!existing) {
      reject(op.type, title, 'target_not_found');
      continue;
    }

    if (op.action === 'patch') {
      const before = (op.before ?? '').trim();
      if (before.length < 20 || !existing.content.includes(before)) {
        reject(op.type, title, 'before_mismatch');
        continue;
      }
      seenTitles.add(`${op.type}:${title}`);
      ops.push({
        op: 'patch',
        type: op.type,
        path: target,
        title,
        content,
        before,
        meta: metaOf(op.type, scope, evidence.refs),
      });
      continue;
    }

    // append
    if (existing.content.includes(content)) {
      reject(op.type, title, 'append_duplicate');
      continue;
    }
    seenTitles.add(`${op.type}:${title}`);
    ops.push({ op: 'append', type: op.type, path: target, content });
  }

  return { ops, rejected };
}

function metaOf(type: string, scope: string, evidence: EvidenceRef[]): MemoryMeta {
  return {
    id: newMemoryId(idPrefix(type)),
    kind: inferKind(type),
    status: 'active',
    version: 1,
    evidence,
    promptVersion: 'ops-v1',
    ...(scope ? { scope } : {}),
  };
}

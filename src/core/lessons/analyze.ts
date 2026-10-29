/** 阶段 4:会话摘要、分类与打分。摘要/分类走 LlmProvider,打分走 JevProvider,均可 mock。 */
import type { Event } from '../events/schema.js';
import type { LlmProvider } from './llm.js';
import type { JevProvider, JevScores } from './jev.js';

export type Outcome = 'success' | 'failure' | 'partial' | 'trivial';

export interface SessionSummary {
  topic: string;
  intent: string;
  outcome: Outcome;
  keySteps: string[];
  hasError: boolean;
  hasCorrection: boolean;
  hasWorkflow: boolean;
}

export interface Classification {
  preferences: boolean;
  entities: boolean;
  experiences: boolean;
  events: boolean;
  resources: boolean;
}

export type AnalyzeResult =
  | { status: 'continue'; summary: SessionSummary; classification: Classification }
  | { status: 'skip'; reason: 'trivial' | 'no_category' | 'low_score'; scores?: JevScores };

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    intent: { type: 'string' },
    outcome: { type: 'string', enum: ['success', 'failure', 'partial', 'trivial'] },
    keySteps: { type: 'array', items: { type: 'string' } },
    hasError: { type: 'boolean' },
    hasCorrection: { type: 'boolean' },
    hasWorkflow: { type: 'boolean' },
  },
  required: ['topic', 'intent', 'outcome', 'keySteps', 'hasError', 'hasCorrection', 'hasWorkflow'],
};

const CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    preferences: { type: 'boolean' },
    entities: { type: 'boolean' },
    experiences: { type: 'boolean' },
    events: { type: 'boolean' },
    resources: { type: 'boolean' },
  },
  required: ['preferences', 'entities', 'experiences', 'events', 'resources'],
};

const SCORE_TASK_SUCCESS_MIN = 0.5;
const SCORE_MEAN_MIN = 0.6;

export async function summarizeSession(events: Event[], llm: LlmProvider): Promise<SessionSummary> {
  const raw = await llm.generate<unknown>(renderEvents(events), SUMMARY_SCHEMA);
  return validateSummary(raw);
}

export async function classifySession(summary: SessionSummary, llm: LlmProvider): Promise<Classification> {
  const raw = await llm.generate<unknown>(JSON.stringify(summary), CLASSIFY_SCHEMA);
  return validateClassification(raw);
}

export function anyCategory(c: Classification): boolean {
  return c.preferences || c.entities || c.experiences || c.events || c.resources;
}

export interface AnalyzeDeps {
  llm: LlmProvider;
  jev: JevProvider;
}

/** 阶段 4 总入口:摘要 → 分类 → 打分,任一不达标即跳过并说明原因。 */
export async function analyzeSession(events: Event[], deps: AnalyzeDeps): Promise<AnalyzeResult> {
  const summary = await summarizeSession(events, deps.llm);
  if (summary.outcome === 'trivial') return { status: 'skip', reason: 'trivial' };
  const classification = await classifySession(summary, deps.llm);
  if (!anyCategory(classification)) return { status: 'skip', reason: 'no_category' };
  const scores = await deps.jev.score({ summary, events });
  if (scores.taskSuccess < SCORE_TASK_SUCCESS_MIN || scores.meanScore < SCORE_MEAN_MIN) {
    return { status: 'skip', reason: 'low_score', scores };
  }
  return { status: 'continue', summary, classification };
}

function validateSummary(raw: unknown): SessionSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`摘要解析失败:期望对象,得到 ${JSON.stringify(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  const outcome = r.outcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial' && outcome !== 'trivial') {
    throw new Error(`摘要 outcome 非法:${JSON.stringify(outcome)}`);
  }
  const steps = Array.isArray(r.keySteps) ? r.keySteps.map((s) => String(s)) : [];
  return {
    topic: String(r.topic ?? ''),
    intent: String(r.intent ?? ''),
    outcome,
    keySteps: steps,
    hasError: Boolean(r.hasError),
    hasCorrection: Boolean(r.hasCorrection),
    hasWorkflow: Boolean(r.hasWorkflow),
  };
}

function validateClassification(raw: unknown): Classification {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`分类解析失败:期望对象,得到 ${JSON.stringify(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  return {
    preferences: Boolean(r.preferences),
    entities: Boolean(r.entities),
    experiences: Boolean(r.experiences),
    events: Boolean(r.events),
    resources: Boolean(r.resources),
  };
}

export function renderEvents(events: Event[]): string {
  return events
    .map((e) => {
      const text = e.text ?? (typeof e.result?.output === 'string' ? e.result.output : '');
      const kind = e.kind === 'tool_result' && e.result?.status === 'error' ? 'error' : e.kind;
      let line = `[${e.seq}] ${kind}${text ? `: ${text}` : ''}`;
      // 溯源:raw 文件行号 + tool 入参(可能含 URL/路径),供 resources 记忆完全可溯源。
      if (e.raw) line += ` @${e.raw.path}:${e.raw.line}`;
      if (e.tool?.input !== undefined) {
        const input = typeof e.tool.input === 'string' ? e.tool.input : JSON.stringify(e.tool.input);
        if (input && input !== 'undefined') line += ` (input: ${input})`;
      }
      return line;
    })
    .join('\n');
}

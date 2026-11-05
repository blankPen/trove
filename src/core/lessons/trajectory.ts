/** 轨迹(事实层):LLM 只生成 task/outcome/reusableSignals,正文由事件确定性渲染,保证事实层不编造。 */
import type { Event } from '../events/schema.js';
import { safeSessionName } from '../layout.js';
import type { SessionSummary } from './analyze.js';
import { renderEvents } from './analyze.js';
import type { LlmProvider } from './llm.js';
import type { EvidenceRef, MemoryV2 } from './memory.js';
import { renderMemory } from './memory.js';
import { slugify } from './schema.js';
import { projectSlug } from './scope.js';
import type { StorageAdapter } from './storage.js';

export type TrajectoryOutcome = 'success' | 'failure' | 'partial' | 'unfinished' | 'unknown';

export interface TrajectoryFacts {
  task: string;
  outcome: TrajectoryOutcome;
  reusableSignals: string[];
}

const FACTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    outcome: { type: 'string', enum: ['success', 'failure', 'partial', 'unfinished', 'unknown'] },
    reusableSignals: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'outcome', 'reusableSignals'],
};

const OUTCOMES: TrajectoryOutcome[] = ['success', 'failure', 'partial', 'unfinished', 'unknown'];

/** 用户纠正消息的确定性信号;事实层不允许依赖 LLM 判断「这句是不是纠正」。 */
const CORRECTION_RE = /(改成|应该|不对|纠正|错了|修正|错在|instead|should|fix|wrong)/i;

export async function extractTrajectoryFacts(
  summary: SessionSummary,
  events: Event[],
  deps: { llm: LlmProvider },
): Promise<TrajectoryFacts> {
  const raw = await deps.llm.generate<{ task?: unknown; outcome?: unknown; reusableSignals?: unknown }>(
    [`从会话摘要与事件中提取轨迹事实(只生成事实,不要编造):`,
      `摘要:${JSON.stringify(summary)}`,
      '事件:',
      renderEvents(events)].join('\n'),
    FACTS_SCHEMA,
    'learn:trajectory',
  );
  const task = typeof raw?.task === 'string' ? raw.task.trim() : '';
  let outcome: TrajectoryOutcome = (OUTCOMES as string[]).includes(raw?.outcome as string) ? (raw.outcome as TrajectoryOutcome) : 'unknown';
  if (summary.outcome === 'failure' && (outcome === 'success' || outcome === 'partial')) outcome = 'failure';
  const reusableSignals = Array.isArray(raw?.reusableSignals) ? raw.reusableSignals.map(String).filter((s) => s.trim()) : [];
  return { task, outcome, reusableSignals };
}

export interface TrajectoryInput {
  id: string;
  session: string;
  project: string;
  summary: SessionSummary;
  facts: TrajectoryFacts;
  events: Event[];
  createdAt: string;
}

/** 事件正文:消息取 text,tool_call 取名,tool_result 取字符串 output。 */
function eventText(e: Event): string {
  if (e.kind === 'tool_call') return e.tool?.name ?? '';
  if (e.kind === 'tool_result') return typeof e.result?.output === 'string' ? e.result.output : '';
  return e.text ?? '';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}`;
}

function loc(e: Event): string {
  return e.raw ? ` @${e.raw.path}:${e.raw.line}` : '';
}

function isStep(e: Event): boolean {
  if (e.kind === 'message') return e.role === 'user' || e.role === 'assistant';
  return e.kind === 'tool_call' || e.kind === 'tool_result';
}

function isError(e: Event): boolean {
  return e.kind === 'tool_result' && e.result?.status === 'error';
}

function isCorrection(e: Event): boolean {
  return e.kind === 'message' && e.role === 'user' && CORRECTION_RE.test(e.text ?? '');
}

function buildEvidence(events: Event[], session: string): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const e of events) {
    if (!isError(e) && !isCorrection(e)) continue;
    const quote = eventText(e);
    if ([...quote].length < 12) continue; // 不足 12 码点不可作为可靠证据,跳过该条
    out.push({
      session,
      seq: e.seq,
      quote: clip(quote, 200),
      ...(e.raw?.path ? { path: e.raw.path } : {}),
      ...(e.raw?.line !== undefined ? { line: e.raw.line } : {}),
    });
  }
  return out;
}

export function renderTrajectory(input: TrajectoryInput): { path: string; text: string; evidence: EvidenceRef[] } {
  const { id, session, project, summary, facts, events, createdAt } = input;
  const evidence = buildEvidence(events, session);

  const steps = [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter(isStep)
    .slice(0, 80)
    .map((e) => {
      const kind = e.kind === 'message' ? `message:${e.role ?? ''}` : e.kind;
      const t = oneLine(eventText(e));
      return clip(`- [${e.seq}] ${kind}${t ? `: ${t}` : ''}${loc(e)}`, 300);
    });

  const verify = [`outcome: ${facts.outcome}`];
  if (summary.intent) verify.push(`intent: ${summary.intent}`);
  for (const s of summary.keySteps.slice(0, 8)) verify.push(`- ${s}`);

  const failures: string[] = [];
  for (const e of events) {
    if (isError(e)) failures.push(clip(`- [${e.seq}] ${eventText(e)}`, 300));
    else if (isCorrection(e)) failures.push(clip(`- [${e.seq}] ${eventText(e)}`, 300));
  }
  if (failures.length === 0) failures.push('- 无');

  const signals = facts.reusableSignals.length ? facts.reusableSignals.map((s) => `- ${s}`) : ['- 无'];

  const body = [
    `## 任务`,
    facts.task || '- 无',
    '',
    `## 执行步骤`,
    ...steps,
    '',
    `## 结果与验证`,
    ...verify,
    '',
    `## 失败/弯路（如有）`,
    ...failures,
    '',
    `## 可复用信号（候选，不直接当经验）`,
    ...signals,
  ].join('\n');

  const mem: MemoryV2 = {
    id,
    kind: 'trajectory',
    type: 'trajectories/capture',
    title: facts.task || '未命名轨迹',
    tags: ['trajectory'],
    scope: `project:${projectSlug(project) || 'unknown'}`,
    status: 'active',
    version: 1,
    evidence,
    createdAt,
    updatedAt: createdAt,
    useCount: 0,
    helpfulCount: 0,
    body,
  };

  const path = buildPath(createdAt.slice(0, 10), session, facts.task);
  return { path, text: renderMemory(mem), evidence };
}

export async function writeTrajectory(storage: StorageAdapter, input: TrajectoryInput): Promise<{ id: string; path: string }> {
  const { path, text } = renderTrajectory(input);
  await storage.write(path, text);
  return { id: input.id, path };
}

function buildPath(date: string, session: string, task: string): string {
  const slug = sanitize(slugify(task));
  const name = sanitize(`${date}-${safeSessionName(session)}-${slug}`).replace(/^-+|-+$/g, '');
  return `trajectories/${(name || 'capture').slice(0, 120)}.md`;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** 阶段 9:用 LangGraph 把阶段 3~8 编排成提取流水线,支持内存检查点断点续跑。 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Event } from '../events/schema.js';
import { selectSession } from './select.js';
import { analyzeSession } from './analyze.js';
import type { AnalyzeResult } from './analyze.js';
import { extractMemories } from './extract.js';
import type { MemoryCandidate } from './extract.js';
import { mergeMemories } from './merge.js';
import type { MemoryOp } from './merge.js';
import { loadExistingMemories } from './existing.js';
import { applyOperations } from './write.js';
import type { ApplyResult } from './write.js';
import { buildMemoryDiff, writeMemoryDiff } from './audit.js';
import type { MemoryDiff } from './audit.js';
import type { LlmProvider } from './llm.js';
import type { JevProvider } from './jev.js';
import type { StorageAdapter } from './storage.js';

export interface LessonDeps {
  llm: LlmProvider;
  jev: JevProvider;
  storage: StorageAdapter;
  loadEvents: (sessionId: string) => Promise<Event[]>;
  /** 可控时钟,测试用;缺省系统时间。 */
  now?: () => Date;
}

/** 流水线节点名;interruptBefore 只能落到这些名字上。 */
export type LessonNodeName = 'load' | 'select' | 'analyze' | 'extract' | 'merge' | 'write' | 'audit';

export interface LessonGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  interruptBefore?: LessonNodeName[];
}

export const LessonState = Annotation.Root({
  sessionId: Annotation<string>,
  events: Annotation<Event[] | undefined>,
  project: Annotation<string | undefined>,
  skip: Annotation<{ reason: string } | undefined>,
  analysis: Annotation<AnalyzeResult | undefined>,
  candidates: Annotation<MemoryCandidate[] | undefined>,
  ops: Annotation<MemoryOp[] | undefined>,
  result: Annotation<ApplyResult | undefined>,
  diff: Annotation<MemoryDiff | undefined>,
});

type State = typeof LessonState.State;

export function buildLessonGraph(deps: LessonDeps, opts: LessonGraphOptions = {}) {
  const now = deps.now ?? (() => new Date());

  async function load(state: State) {
    const events = await deps.loadEvents(state.sessionId);
    const header = events.find((e) => e.kind === 'session');
    return { events, project: header?.cwd ?? state.sessionId };
  }

  function select(state: State) {
    const sel = selectSession(state.events ?? [], now());
    if (sel.status === 'skipped') return { skip: { reason: sel.reason } };
    return { events: sel.events };
  }

  function afterSelect(state: State) {
    return state.skip ? END : 'analyze';
  }

  async function analyze(state: State) {
    const analysis = await analyzeSession(state.events ?? [], { llm: deps.llm, jev: deps.jev });
    if (analysis.status === 'skip') return { skip: { reason: analysis.reason } };
    return { analysis };
  }

  function afterAnalyze(state: State) {
    return state.skip ? END : 'extract';
  }

  async function extract(state: State) {
    const analysis = state.analysis;
    if (!analysis || analysis.status !== 'continue') {
      throw new Error('提取节点前置状态异常:analysis 未就绪');
    }
    const candidates = await extractMemories(analysis.summary, analysis.classification, state.events ?? [], { llm: deps.llm });
    return { candidates };
  }

  async function merge(state: State) {
    const existing = await loadExistingMemories(deps.storage);
    return { ops: await mergeMemories(state.candidates ?? [], existing, { llm: deps.llm }) };
  }

  async function write(state: State) {
    return { result: await applyOperations(state.ops ?? [], { storage: deps.storage, now: deps.now, source: state.sessionId }) };
  }

  async function audit(state: State) {
    const diff = buildMemoryDiff(state.ops ?? [], { sessionId: state.sessionId, project: state.project ?? state.sessionId });
    await writeMemoryDiff(diff, deps.storage);
    return { diff };
  }

  return new StateGraph(LessonState)
    .addNode('load', load)
    .addNode('select', select)
    .addNode('analyze', analyze)
    .addNode('extract', extract)
    .addNode('merge', merge)
    .addNode('write', write)
    .addNode('audit', audit)
    .addEdge(START, 'load')
    .addEdge('load', 'select')
    .addConditionalEdges('select', afterSelect)
    .addConditionalEdges('analyze', afterAnalyze)
    .addEdge('extract', 'merge')
    .addEdge('merge', 'write')
    .addEdge('write', 'audit')
    .addEdge('audit', END)
    .compile({ checkpointer: opts.checkpointer, interruptBefore: opts.interruptBefore ?? [] });
}

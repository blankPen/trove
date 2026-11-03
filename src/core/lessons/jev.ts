/** Jev 打分抽象(阶段 4):给会话 state 打分,返回 task_success 与 mean_score 两个 0~1 数值。 */
import type { JevConfig } from './config.js';

export interface JevScores {
  taskSuccess: number;
  meanScore: number;
}

/** Jev 批量 noul 判定的问题描述:每个 key 对应一个待判对象(如一个 tool 调用对)。 */
export interface JevKeepQuestion {
  instructions: string;
}

export interface JevProvider {
  score(state: unknown): Promise<JevScores>;
  /** 快速压缩:对 questions 每个 key 出一个 0~1 关键概率(noul)。可选——未实现时 compaction 降级为确定性截断。 */
  keepCalls?(state: unknown, questions: Record<string, JevKeepQuestion>): Promise<Record<string, number>>;
}

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 复用价值评分档位(score 原语,档位越靠后越高);mean_score 用档位加权均值归一化到 0~1。 */
const VALUE_LEVELS = ['不可复用:琐碎、无通用价值', '部分可复用:特定上下文有价值', '高可复用:可跨场景迁移的经验'];

/** TypeSafe Jev 真实实现:一次请求两个问题(task_success 用 noul,value 用 score)。 */
export class TypeSafeJevScorer implements JevProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: JevConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? JEV_ENDPOINT;
  }

  async score(state: unknown): Promise<JevScores> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        state,
        questions: {
          task_success: {
            type: 'noul',
            instructions: '这个会话是否成功完成了用户的任务,或达成了清晰、可用的结论?',
          },
          value: {
            type: 'score',
            instructions: '这个会话沉淀的经验可复用程度如何?',
            criteria: VALUE_LEVELS,
          },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Jev 打分失败:HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as JevResponse;
    const taskSuccess = data.answers?.task_success?.noul;
    const value = data.answers?.value?.score;
    if (typeof taskSuccess !== 'number' || typeof value !== 'number') {
      throw new Error(`Jev 返回结构不符:${JSON.stringify(data)}`);
    }
    const top = VALUE_LEVELS.length - 1;
    const meanScore = top > 0 ? value / top : 0;
    return { taskSuccess, meanScore: clamp01(meanScore) };
  }

  async keepCalls(state: unknown, questions: Record<string, JevKeepQuestion>): Promise<Record<string, number>> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [id, { type: 'noul', instructions: q.instructions }]),
        ),
      }),
    });
    if (!res.ok) {
      throw new Error(`Jev 压缩判定失败:HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const out: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const n = data.answers?.[id]?.noul;
      if (typeof n !== 'number') {
        throw new Error(`Jev 压缩判定结构不符:${JSON.stringify(data)}`);
      }
      out[id] = clamp01(n);
    }
    return out;
  }
}

interface JevResponse {
  answers?: {
    task_success?: { noul?: number };
    value?: { score?: number };
  };
}

/** 降级开关:恒返回通过分数、压缩时全保留,仅本地调试用,默认不使用。 */
export class PassThroughJev implements JevProvider {
  async score(_state: unknown): Promise<JevScores> {
    return { taskSuccess: 1, meanScore: 1 };
  }

  async keepCalls(_state: unknown, questions: Record<string, JevKeepQuestion>): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(questions).map((id) => [id, 1]));
  }
}

export type JevResponder = (state: unknown) => JevScores | Promise<JevScores>;

/** mock 实现:按注入回调返回固定分数,不发起任何网络请求。 */
export class MockJev implements JevProvider {
  constructor(private responder: JevResponder) {}

  async score(state: unknown): Promise<JevScores> {
    return this.responder(state);
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
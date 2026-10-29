/** Jev 打分抽象(阶段 4):给会话 state 打分,返回 task_success 与 mean_score 两个 0~1 数值。 */
import type { JevConfig } from './config.js';

export interface JevScores {
  taskSuccess: number;
  meanScore: number;
}

export interface JevProvider {
  score(state: unknown): Promise<JevScores>;
}

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 复用价值评分档位(score 原语,档位越靠后越高);mean_score 用档位加权均值归一化到 0~1。 */
const VALUE_LEVELS = ['不可复用:琐碎、无通用价值', '部分可复用:特定上下文有价值', '高可复用:可跨场景迁移的经验'];

/** TypeSafe Jev 真实实现:一次请求两个问题(task_success 用 noul,value 用 score)。 */
export class TypeSafeJevScorer implements JevProvider {
  private apiKey: string;
  private model: string;

  constructor(config: JevConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async score(state: unknown): Promise<JevScores> {
    const res = await fetch(JEV_ENDPOINT, {
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
}

interface JevResponse {
  answers?: {
    task_success?: { noul?: number };
    value?: { score?: number };
  };
}

/** 降级开关:恒返回通过分数,仅本地调试用,默认不使用。 */
export class PassThroughJev implements JevProvider {
  async score(_state: unknown): Promise<JevScores> {
    return { taskSuccess: 1, meanScore: 1 };
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
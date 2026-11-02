/** LLM 抽象:给提示词 + 期望的 JSON 结构,返回解析后的对象。一期接 DeepSeek,测试用 mock 注入固定返回。 */
import { ChatOpenAI } from '@langchain/openai';
import type { LlmConfig } from './config.js';
import type { UsageSink } from './usage.js';

export interface LlmProvider {
  /**
   * 用提示词生成符合给定 JSON Schema 的对象。schema 为 JSON Schema 对象描述。
   * task 只用于 token 用量归因(如 learn:summarize),不影响生成结果。
   */
  generate<T>(prompt: string, schema: Record<string, unknown>, task?: string): Promise<T>;
}

export interface DeepSeekLlmOptions {
  /** 每次调用后上报 token 用量;上报失败不影响生成结果。 */
  onUsage?: UsageSink;
}

/** DeepSeek(OpenAI 兼容)实现:json_object 模式返回纯 JSON,内容手动解析(DeepSeek 不支持 json_schema 的 response_format)。 */
export class DeepSeekLlm implements LlmProvider {
  private llm: ChatOpenAI;
  private model: string;

  constructor(
    config: LlmConfig,
    private options: DeepSeekLlmOptions = {},
  ) {
    this.model = config.model;
    this.llm = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }

  async generate<T>(prompt: string, schema: Record<string, unknown>, task = 'llm'): Promise<T> {
    // schema 注入 prompt 引导字段;json_object 要求 prompt 含 "json" 字样,故用 JSON Schema 措辞。
    const full = `${prompt}\n\n按以下 JSON Schema 返回一个 JSON 对象,不要输出其它内容:\n${JSON.stringify(schema)}`;
    const res = await this.llm.invoke(full);
    // tokens 已实际消耗:先记账再解析,解析失败也不能漏记;写盘失败不拖垮提取。
    const usage = usageOfMessage(res);
    if (usage) {
      try {
        await this.options.onUsage?.({ task, model: this.model, ...usage });
      } catch {
        // 用量统计失败不影响生成
      }
    }
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    return parseJsonObject<T>(text);
  }
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 从 LangChain AIMessage 提取 token 用量:优先 usage_metadata,回退 OpenAI 的 response_metadata.tokenUsage。 */
export function usageOfMessage(res: unknown): MessageUsage | null {
  if (typeof res !== 'object' || res === null) return null;
  const r = res as Record<string, unknown>;
  if (isObject(r.usage_metadata)) {
    const m = r.usage_metadata;
    const usage = normalize(intOf(m.input_tokens), intOf(m.output_tokens), intOf(m.total_tokens));
    if (usage) return usage;
  }
  const response = r.response_metadata;
  if (isObject(response) && isObject(response.tokenUsage)) {
    const m = response.tokenUsage;
    const usage = normalize(intOf(m.promptTokens), intOf(m.completionTokens), intOf(m.totalTokens));
    if (usage) return usage;
  }
  return null;
}

function normalize(promptTokens: number, completionTokens: number, totalTokens: number): MessageUsage | null {
  const total = totalTokens || promptTokens + completionTokens;
  return promptTokens + completionTokens + total > 0
    ? { promptTokens, completionTokens, totalTokens: total }
    : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function intOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/** 清洗 LLM 返回文本(去掉 ```json 围栏与首尾空白)并解析为对象;失败抛可读错误。 */
export function parseJsonObject<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`LLM 返回无法解析为 JSON:${text.slice(0, 200)}`);
  }
}

export type LlmResponder = (
  prompt: string,
  schema: Record<string, unknown>,
  task?: string,
) => unknown | Promise<unknown>;

/** mock 实现:按注入的回调返回固定对象,不发起任何网络请求。 */
export class MockLlm implements LlmProvider {
  constructor(private responder: LlmResponder) {}

  async generate<T>(prompt: string, schema: Record<string, unknown>, task?: string): Promise<T> {
    return (await this.responder(prompt, schema, task)) as T;
  }
}

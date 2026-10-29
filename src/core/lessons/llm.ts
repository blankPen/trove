/** LLM 抽象:给提示词 + 期望的 JSON 结构,返回解析后的对象。一期接 DeepSeek,测试用 mock 注入固定返回。 */
import { ChatOpenAI } from '@langchain/openai';
import type { LlmConfig } from './config.js';

export interface LlmProvider {
  /** 用提示词生成符合给定 JSON Schema 的对象。schema 为 JSON Schema 对象描述。 */
  generate<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
}

/** DeepSeek(OpenAI 兼容)实现:json_object 模式返回纯 JSON,内容手动解析(DeepSeek 不支持 json_schema 的 response_format)。 */
export class DeepSeekLlm implements LlmProvider {
  private llm: ChatOpenAI;

  constructor(config: LlmConfig) {
    this.llm = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }

  async generate<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    // schema 注入 prompt 引导字段;json_object 要求 prompt 含 "json" 字样,故用 JSON Schema 措辞。
    const full = `${prompt}\n\n按以下 JSON Schema 返回一个 JSON 对象,不要输出其它内容:\n${JSON.stringify(schema)}`;
    const res = await this.llm.invoke(full);
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    return parseJsonObject<T>(text);
  }
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
) => unknown | Promise<unknown>;

/** mock 实现:按注入的回调返回固定对象,不发起任何网络请求。 */
export class MockLlm implements LlmProvider {
  constructor(private responder: LlmResponder) {}

  async generate<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    return (await this.responder(prompt, schema)) as T;
  }
}

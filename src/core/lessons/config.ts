/** 模型端点配置读取:从 ~/.trove/config.json 的 llm/jev 段读取,缺配置时明确报错而非静默失败。 */
import type { Config } from '../../config.js';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface JevConfig {
  apiKey: string;
  model: string;
  /** 缺省用官方端点;可指向代理/镜像 */
  baseUrl?: string;
}

export function readLlmConfig(config?: Pick<Config, 'llm'>): LlmConfig {
  const baseUrl = config?.llm?.baseUrl;
  const model = config?.llm?.model;
  const apiKey = config?.llm?.apiKey;
  if (!baseUrl || !model || !apiKey) {
    const missing = [
      ['llm.baseUrl', baseUrl],
      ['llm.model', model],
      ['llm.apiKey', apiKey],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(`缺少 LLM 配置:${missing.join('、')};请用 trove config set llm.baseUrl/llm.model/llm.apiKey 写入 ~/.trove/config.json`);
  }
  return { baseUrl, model, apiKey };
}

export function readJevConfig(config?: Pick<Config, 'jev'>): JevConfig {
  const apiKey = config?.jev?.apiKey;
  const model = config?.jev?.model;
  if (!apiKey || !model) {
    const missing = [
      ['jev.apiKey', apiKey],
      ['jev.model', model],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(`缺少 Jev 配置:${missing.join('、')};请用 trove config set jev.apiKey/jev.model 写入 ~/.trove/config.json`);
  }
  return { apiKey, model, ...(config?.jev?.baseUrl ? { baseUrl: config.jev.baseUrl } : {}) };
}

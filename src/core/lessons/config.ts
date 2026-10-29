/** 模型端点配置读取:从 .env(经 --env-file 或进程环境变量)读取,缺配置时明确报错而非静默失败。 */

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface JevConfig {
  apiKey: string;
  model: string;
}

type Env = Record<string, string | undefined>;

export function readLlmConfig(env: Env = process.env): LlmConfig {
  const baseUrl = env.TEXT_MODEL_BASE_URL;
  const model = env.TEXT_MODEL;
  const apiKey = env.TEXT_MODEL_API_KEY;
  if (!baseUrl || !model || !apiKey) {
    const missing = ['TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_API_KEY'].filter(
      (k) => !env[k],
    );
    throw new Error(`缺少 LLM 配置:${missing.join('、')};请在 .env 或进程环境变量中设置`);
  }
  return { baseUrl, model, apiKey };
}

export function readJevConfig(env: Env = process.env): JevConfig {
  const apiKey = env.TYPESAFE_API_KEY;
  const model = env.TYPESAFE_MODEL;
  if (!apiKey || !model) {
    const missing = ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'].filter((k) => !env[k]);
    throw new Error(`缺少 Jev 配置:${missing.join('、')};请在 .env 或进程环境变量中设置`);
  }
  return { apiKey, model };
}

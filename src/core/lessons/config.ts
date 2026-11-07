/** 模型端点配置读取:从 ~/.trove/config.json 的 llm/jev 段读取,缺配置时明确报错而非静默失败。 */
import { defaultLearnConfig, normalizeEmbeddingProvider, normalizeLearnMode, type Config, type LearnConfig } from '../../config.js';

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
  const cfg = readJevConfigOrNull(config);
  if (!cfg) {
    const missing = [
      ['jev.apiKey', config?.jev?.apiKey],
      ['jev.model', config?.jev?.model],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(`缺少 Jev 配置:${missing.join('、')};请用 trove config set jev.apiKey/jev.model 写入 ~/.trove/config.json`);
  }
  return cfg;
}

/** 可选读取:Jev 未配置返回 null(外部增强缺失不阻断学习),不抛错。 */
export function readJevConfigOrNull(config?: Pick<Config, 'jev'>): JevConfig | null {
  const j = config?.jev;
  if (!j?.apiKey || !j.model) return null;
  return { apiKey: j.apiKey, model: j.model, ...(j.baseUrl ? { baseUrl: j.baseUrl } : {}) };
}

/** 读取 v2 学习配置:缺省补默认,quality 数值钳制到 [0,1],非法 mode 白名单兜底 review。 */
export function readLearnConfig(config?: Pick<Config, 'learn'>): LearnConfig {
  const d = defaultLearnConfig();
  const l = (config?.learn ?? {}) as Partial<LearnConfig>;
  return {
    mode: normalizeLearnMode(l.mode),
    autoMigrate: l.autoMigrate !== false,
    paused: l.paused === true,
    dailyTokenBudget: nonNeg(l.dailyTokenBudget, d.dailyTokenBudget),
    maxAttempts: clampInt(l.maxAttempts, d.maxAttempts, 1, 20),
    leaseTtlMs: Math.max(10000, nonNeg(l.leaseTtlMs, d.leaseTtlMs)),
    quality: {
      autoAccept: clamp01(l.quality?.autoAccept, d.quality.autoAccept),
      reviewFloor: clamp01(l.quality?.reviewFloor, d.quality.reviewFloor),
      evidenceMin: clamp01(l.quality?.evidenceMin, d.quality.evidenceMin),
    },
    jev: {
      maxCallsPerSession: nonNeg(l.jev?.maxCallsPerSession, d.jev.maxCallsPerSession),
      timeoutMs: nonNeg(l.jev?.timeoutMs, d.jev.timeoutMs),
    },
    lifecycle: {
      staleDays: nonNeg(l.lifecycle?.staleDays, d.lifecycle.staleDays),
      archiveDays: nonNeg(l.lifecycle?.archiveDays, d.lifecycle.archiveDays),
      trajectoryDays: nonNeg(l.lifecycle?.trajectoryDays, d.lifecycle.trajectoryDays),
      trajectoryMax: clampInt(l.lifecycle?.trajectoryMax, d.lifecycle.trajectoryMax, 0, 100000),
    },
    capacity: {
      experiencesPerProject: nonNeg(l.capacity?.experiencesPerProject, d.capacity.experiencesPerProject),
      experiencesGlobal: nonNeg(l.capacity?.experiencesGlobal, d.capacity.experiencesGlobal),
      profileBytes: nonNeg(l.capacity?.profileBytes, d.capacity.profileBytes),
      entitiesPerType: nonNeg(l.capacity?.entitiesPerType, d.capacity.entitiesPerType),
    },
    search: {
      enabled: l.search?.enabled !== false,
      provider: normalizeEmbeddingProvider(l.search?.provider),
      model: strNonEmpty(l.search?.model, d.search.model),
      host: strNonEmpty(l.search?.host, d.search.host),
      minScore: nonNeg(l.search?.minScore, d.search.minScore),
      dashscope: {
        apiKey: strNonEmpty(l.search?.dashscope?.apiKey, d.search.dashscope.apiKey),
        baseUrl: strNonEmpty(l.search?.dashscope?.baseUrl, d.search.dashscope.baseUrl),
        model: strNonEmpty(l.search?.dashscope?.model, d.search.dashscope.model),
        dimension: clampInt(l.search?.dashscope?.dimension, d.search.dashscope.dimension, 1, 4096),
      },
    },
  };
}

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function nonNeg(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < 0 ? 0 : n;
}

function strNonEmpty(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return n < min ? min : n > max ? max : n;
}

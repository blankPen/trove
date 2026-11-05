/** 本地向量编码：bge-small-zh 经 transformers.js 提取 512 维向量，加载失败降级为纯 FTS。 */
import type { MemoryV2 } from './memory.js';

/** 运行时编码配置；由 learn.embedding 映射而来，batchSize/timeoutMs 为运行时缺省。 */
export interface EmbeddingConfig {
  enabled: boolean;
  model: string;
  host: string;
  batchSize?: number;
  timeoutMs?: number;
}

/** 编码器：一次性批量编码文本为等长 Float32Array。 */
export interface Embedder {
  dims: number;
  encode(texts: string[]): Promise<Float32Array[]>;
}

/** transformers.js 特征抽取 pipeline 的调用形态。 */
export type PipelineFn = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ dims: number[]; data: Float32Array }>;

export interface GetEmbedderOpts {
  cacheDir?: string;
  /** 首次下载进度(transformers.js progress_callback);已缓存时不触发。 */
  onProgress?: (p: DownloadProgress) => void;
  /** 测试注入假 pipeline；缺省动态 import transformers.js（不联网测试不触发）。 */
  loadPipeline?: (cfg: EmbeddingConfig, cacheDir?: string) => Promise<PipelineFn>;
}

/** transformers.js 下载进度事件;total 未知时为 0。 */
export interface DownloadProgress {
  status: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

const MIN_CODEPOINTS = 8;

/** 过短文本编码无意义（< 8 码点），直接跳过。 */
export function isEmbeddableText(s: string): boolean {
  return [...s].length >= MIN_CODEPOINTS;
}

/** 经验类只抽「适用场景 / 做法 / 边界与反例」三节；其它类目回退全文。 */
export function embedText(mem: MemoryV2): string {
  if (mem.type && !mem.type.startsWith('experiences/')) return mem.body.trim();
  const sections = new Set(['适用场景', '做法', '边界与反例']);
  const out: string[] = [];
  let inSection = false;
  for (const line of mem.body.split('\n')) {
    const m = /^##\s+(.+)$/.exec(line.trim());
    if (m) {
      inSection = sections.has(m[1]!.trim());
      continue;
    }
    if (inSection) out.push(line);
  }
  const text = out.join('\n').trim();
  return text.length ? text : mem.body.trim();
}

/** 加载编码器；enabled=false 或加载失败返回 null（调用方回退 FTS）。 */
export async function getEmbedder(cfg: EmbeddingConfig, opts: GetEmbedderOpts = {}): Promise<Embedder | null> {
  if (!cfg.enabled) return null;
  let fn: PipelineFn;
  try {
    fn = opts.loadPipeline
      ? await opts.loadPipeline(cfg, opts.cacheDir)
      : await loadRealPipeline(cfg, opts.cacheDir, opts.onProgress);
  } catch {
    return null;
  }
  // 用一次小探针拿到隐藏层维度（同一 pipeline 的每次输出维度一致）。
  const probe = await fn(['。'], { pooling: 'cls', normalize: true });
  const dims = probe.dims[probe.dims.length - 1] ?? 0;
  const batchSize = Math.max(1, cfg.batchSize ?? 8);
  const timeoutMs = cfg.timeoutMs ?? 60000;
  return {
    dims,
    async encode(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const r = await withTimeout(fn(chunk, { pooling: 'cls', normalize: true }), timeoutMs);
        const d = r.dims[r.dims.length - 1] ?? dims;
        for (let j = 0; j < chunk.length; j++) out.push(r.data.slice(j * d, (j + 1) * d));
      }
      return out;
    },
  };
}

async function loadRealPipeline(
  cfg: EmbeddingConfig,
  cacheDir?: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<PipelineFn> {
  const { env, pipeline } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  env.allowRemoteModels = true;
  if (cfg.host) env.remoteHost = cfg.host;
  const extractor = (await pipeline('feature-extraction', cfg.model, {
    dtype: 'q8',
    ...(onProgress ? { progress_callback: (p: DownloadProgress) => onProgress(p) } : {}),
  })) as unknown as PipelineFn;
  return (texts, options) => extractor(texts, options);
}

/** daemon 启动期依赖预热:加载或下载模型;失败返回 false,调用方降级纯 FTS。 */
export async function ensureEmbeddingModel(
  cfg: EmbeddingConfig,
  opts: GetEmbedderOpts = {},
): Promise<boolean> {
  return (await getEmbedder(cfg, opts)) !== null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`embedding 超时(${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

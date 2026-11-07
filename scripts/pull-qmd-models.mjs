#!/usr/bin/env node
/**
 * 预下载 qmd 三类模型（嵌入 / 查询扩展 / 重排），带进度条。
 * 用法：node scripts/pull-qmd-models.mjs
 *
 * 不走 `qmd pull`：它的 pullModels 会先 HEAD https://huggingface.co 取 etag（写死、无超时），
 * 国内网络下直接挂死。这里直接调 node-llama-cpp 的 resolveModelFile，走 HF_ENDPOINT 镜像。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 必须与 trove 的 learn.search.model 一致；generate/rerank 用 qmd 默认值（trove 未配置）。
const MODELS = [
  process.env.QMD_EMBED_MODEL || 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
  process.env.QMD_GENERATE_MODEL || 'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
  process.env.QMD_RERANK_MODEL || 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
];

process.env.HF_ENDPOINT ||= 'https://hf-mirror.com';

const cacheDir = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, 'qmd', 'models')
  : join(homedir(), '.cache', 'qmd', 'models');
mkdirSync(cacheDir, { recursive: true });

// node-llama-cpp 是 qmd 的依赖，从 qmd 的位置解析才能找到。
const require = createRequire(import.meta.resolve('@tobilu/qmd'));
const { resolveModelFile } = await import(require.resolve('node-llama-cpp'));

console.log(`缓存目录 ${cacheDir}\n镜像 ${process.env.HF_ENDPOINT}`);
for (const [i, model] of MODELS.entries()) {
  console.log(`\n[${i + 1}/${MODELS.length}] ${model}`);
  const path = await resolveModelFile(model, { directory: cacheDir, cli: true });
  console.log(`  ✓ ${path}`);
}

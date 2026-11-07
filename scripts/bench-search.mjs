#!/usr/bin/env node
/**
 * 检索性能基准：CLI 冷启动、进程内首次/热检索、纯 FTS、daemon 端点。
 * 用法：pnpm build && node scripts/bench-search.mjs --label before --out /tmp/bench-before.json
 *
 * 所有数字都是墙钟时间；同一台机器上跑前后两轮才有可比性。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQmdStore, searchQmd, closeQmdStore } from '../dist/core/search/qmd.js';
// client 只在改造后存在；改造前跑基线时降级为 null。
const clientMod = await import('../dist/core/search/client.js').catch(() => null);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = process.env.TROVE_HOME || join(homedir(), '.trove');
const vault = join(base, 'vault');
const dbPath = join(base, 'cache', 'qmd.sqlite');
const model = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const QUERY = 'trove';
const CLI_RUNS = 5;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const label = opt('label', 'run');
const outPath = opt('out', join('/tmp', `bench-${label}.json`));

function runCli(args) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(root, 'dist/main.js'), ...args], { stdio: 'ignore' });
    child.on('close', (code) => resolve({ ms: Math.round(performance.now() - t0), code }));
  });
}

const result = { label, at: new Date().toISOString(), query: QUERY, runs: {} };

// 1. CLI 每次新进程（用户真实体感）
const cli = [];
for (let i = 0; i < CLI_RUNS; i++) cli.push(await runCli(['lessons', 'search', QUERY, '--limit', '3']));
result.runs.cli = cli.map((r) => r.ms);

// 2. 纯 FTS 路径（无模型）
const fts = [];
for (let i = 0; i < 3; i++) fts.push((await runCli(['lessons', 'list', '--limit', '1'])).ms);
result.runs.ftsList = fts;

// 3. 同进程：首次（含模型加载）→ 同 query 热 → 新 query 热
const cfg = { dbPath, model, host: 'https://hf-mirror.com' };
let t = performance.now();
await getQmdStore(vault, cfg);
result.runs.inprocOpen = Math.round(performance.now() - t);
t = performance.now();
await searchQmd(vault, QUERY, cfg, { limit: 3 });
result.runs.inprocFirst = Math.round(performance.now() - t);
t = performance.now();
await searchQmd(vault, QUERY, cfg, { limit: 3 });
result.runs.inprocWarm = Math.round(performance.now() - t);
t = performance.now();
await searchQmd(vault, '怎么配置 llm', cfg, { limit: 3 });
result.runs.inprocNewQuery = Math.round(performance.now() - t);
await closeQmdStore();

// 4. daemon 端点（没有 daemon 或未改造时为空）
const info = clientMod ? await clientMod.readDaemonSearchInfo(base) : null;
if (info) {
  const client = new clientMod.DaemonSearchClient(info);
  const daemon = [];
  for (let i = 0; i < CLI_RUNS; i++) {
    t = performance.now();
    const hits = await client.search(QUERY, { limit: 3 });
    daemon.push({ ms: Math.round(performance.now() - t), hits: hits === null ? null : hits.length });
  }
  result.runs.daemon = daemon;
  result.daemonProtocol = info.protocol;
} else {
  result.runs.daemon = null;
}

const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
result.summary = {
  cliAvgMs: avg(result.runs.cli),
  ftsAvgMs: avg(result.runs.ftsList),
  daemonAvgMs: result.runs.daemon ? avg(result.runs.daemon.map((d) => d.ms)) : null,
};
await writeFile(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary));
console.log(`written ${outPath}`);
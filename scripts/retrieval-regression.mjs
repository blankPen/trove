#!/usr/bin/env node
/**
 * 检索回归：同一批真实查询上跑 qmd 混合检索，输出 hit@1/hit@3。
 * 用法：pnpm build && node scripts/retrieval-regression.mjs [--build]
 *   --build  顺带重建 qmd 索引（首次约 10 分钟，需要本地 GGUF 模型）
 *
 * 查询与主题词取自 docs/superpowers/specs/2026-11-06-trove-learning-retrieval-upgrade.md §3.3。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { syncQmdIndex, searchQmd } from '../dist/core/search/qmd.js';

const base = process.env.TROVE_HOME || join(homedir(), '.trove');
const vaultRoot = join(base, 'vault');
const lessonsRoot = join(vaultRoot, 'library', 'lessons');
const dbPath = join(base, 'cache', 'qmd.sqlite');
const model = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';

const QUERIES = [
  ['为什么数据库连接超时', ['连接池', 'connection timeout', '连接超时']],
  ['webdav 同步慢怎么办', ['webdav']],
  ['怎么配置 llm', ['llm.baseUrl', 'llm.apiKey', '模型端点', 'llm.model']],
  ['trove 的经验提取流程', ['经验提取', '记忆沉淀', '经验沉淀', '记忆蒸馏']],
  ['飞书文档评论怎么读', ['评论', 'comment']],
  ['COS 签名', ['SignatureDoesNotMatch', 'COS 签名']],
  ['SignatureDoesNotMatch', ['SignatureDoesNotMatch']],
  ['quarantine', ['quarantine']],
  ['gitlab webhook', ['gitlab']],
  ['飞书', ['飞书']],
  ['trove', ['trove']],
  ['playwright 截图', ['playwright']],
  ['s3 multipart upload', ['multipart']],
];

const SKIP_DIRS = new Set(['archive', 'audit', 'trajectories', '.trove']);
const SKIP_FILES = new Set(['INDEX.md', 'README.md']);
async function walk(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(root, childRel)));
    } else if (e.isFile() && e.name.endsWith('.md') && !SKIP_FILES.has(e.name)) {
      out.push(childRel);
    }
  }
  return out;
}

const text = new Map();
for (const rel of await walk(lessonsRoot)) {
  const raw = await readFile(join(lessonsRoot, rel), 'utf8');
  // 主题词只看标题与正文；frontmatter 里的 id/kind/tags 会把相关性判成误命中。
  text.set(rel, raw.replace(/^---\n[\s\S]*?\n---\n?/, '').toLowerCase());
}
const isRelevant = (rel, keys) => {
  const t = text.get(rel) ?? '';
  return keys.some((k) => t.includes(k.toLowerCase()));
};
const hit = (list, keys) => {
  const i = list.findIndex((p) => isRelevant(p, keys));
  return { h1: i === 0 ? 1 : 0, h3: i >= 0 && i < 3 ? 1 : 0 };
};

if (process.argv.includes('--build')) {
  console.log('重建 qmd 索引……');
  console.log(JSON.stringify(await syncQmdIndex(vaultRoot, { dbPath, model, host: 'https://hf-mirror.com' })));
}

const rows = [];
for (const [q, keys] of QUERIES) {
  const t0 = Date.now();
  let qmd = [];
  let err = '';
  try {
    qmd = (await searchQmd(vaultRoot, q, { dbPath, model, host: 'https://hf-mirror.com' }, { limit: 3 })).map((h) => h.path);
  } catch (e) {
    err = e.message.slice(0, 80);
  }
  rows.push({ q, keys, qmd, err, ms: Date.now() - t0, qmdH: hit(qmd, keys) });
  console.log(`[${rows.length}/${QUERIES.length}] ${q} (qmd ${Date.now() - t0}ms)`);
}

const n = (field, sub) => rows.filter((r) => r[field][sub] > 0).length;
console.log(`\n查询数 ${rows.length}`);
console.log(`qmd query(hybrid)    hit@1=${n('qmdH', 'h1')}/${rows.length}  hit@3=${n('qmdH', 'h3')}/${rows.length}`);
const avg = rows.reduce((n2, r) => n2 + r.ms, 0) / rows.length;
console.log(`qmd 单条查询平均耗时 ${avg.toFixed(0)}ms`);
console.log('');
for (const r of rows) {
  console.log(`Q: ${r.q}  [主题词 ${r.keys.join('/')}]`);
  console.log(`   qmd  h3=${r.qmdH.h3}${r.err ? ' ERR ' + r.err : ''} ${r.qmd.slice(0, 3).join(' | ') || '(空)'}`);
}

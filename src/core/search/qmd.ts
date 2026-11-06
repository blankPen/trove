/** qmd 检索后端：lessons 目录按类目注册成 qmd collection，检索走 qmd 完整管线（查询扩展 + HyDE + 向量 + RRF + 重排）。 */
import { createStore, type CollectionConfig, type QMDStore } from '@tobilu/qmd';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { libraryLessonsDir } from '../layout.js';

/** lessons 的 5 个记忆类目；各自注册成一个 qmd collection，便于按类目过滤并挂类目描述。 */
export const LESSON_CATEGORIES = ['preferences', 'entities', 'experiences', 'events', 'resources'] as const;

/** 每个类目一段人写描述：qmd 用它补文档语义，是它官方对召回质量影响最大的手段。 */
const CATEGORY_CONTEXT: Record<(typeof LESSON_CATEGORIES)[number], string> = {
  preferences: '用户偏好与长期约定：用户是谁、沟通与编码风格、要求怎么做事。',
  entities: '项目、工具与技术实体档案：仓库、服务、配置项、第三方 API 的事实记录。',
  experiences: '可复用的经验做法：踩过的坑、验证过的做法、适用场景与边界反例。',
  events: '按时间发生的事件与变更：发布、事故、决策及其影响。',
  resources: '外部资料索引：文档、仓库、文章的链接与要点摘要。',
};

export interface QmdSearchConfig {
  /** qmd 索引 SQLite 路径（本地可重建，不参与同步）。 */
  dbPath: string;
  /** 嵌入模型 URI（hf:<repo>/<file>）；缺省用 qmd 自带模型。 */
  model?: string;
  /** 模型下载镜像（HF_ENDPOINT）；缺省沿用环境变量。 */
  host?: string;
  /** 命中条数上限。 */
  limit?: number;
  /** 最低分；低于此分不返回。 */
  minScore?: number;
}

export interface QmdHit {
  /** trove lessons 相对路径，如 experiences/foo.md。 */
  path: string;
  title: string;
  score: number;
}

/** qmd collection 配置：5 个类目各一个 collection + 类目描述 + 嵌入模型。 */
export function qmdCollectionConfig(vaultRoot: string, model?: string): CollectionConfig {
  const root = libraryLessonsDir(vaultRoot);
  const collections: CollectionConfig['collections'] = {};
  for (const cat of LESSON_CATEGORIES) {
    collections[cat] = {
      path: join(root, cat),
      pattern: '**/*.md',
      context: { '/': CATEGORY_CONTEXT[cat] },
    };
  }
  return { collections, ...(model ? { models: { embed: model } } : {}) };
}

/** qmd 返回的文档路径还原成 trove lessons 相对路径；不是记忆目录下的文件返回 null。 */
export function troveRelPath(file: string): string | null {
  const rel = file.replace(/^qmd:\/\//, '');
  const slash = rel.indexOf('/');
  if (slash <= 0) return null;
  const category = rel.slice(0, slash);
  if (!(LESSON_CATEGORIES as readonly string[]).includes(category)) return null;
  return rel;
}

let cached: { key: string; store: QMDStore } | null = null;

/** 打开（或复用）qmd store；模型下载镜像通过 HF_ENDPOINT 传，node-llama-cpp 读环境变量。 */
export async function getQmdStore(vaultRoot: string, cfg: QmdSearchConfig): Promise<QMDStore> {
  const key = `${cfg.dbPath}|${vaultRoot}|${cfg.model ?? ''}`;
  if (cached?.key === key) return cached.store;
  if (cached) await closeQmdStore();
  if (cfg.host && !process.env.HF_ENDPOINT) process.env.HF_ENDPOINT = cfg.host;
  // qmd 默认按显存开多个嵌入上下文；macOS Metal 上多上下文并发会卡在 llama.cpp 的
  // Metal 等待里（实测进程 100% 静默挂死）。固定串行，QMD_EMBED_PARALLELISM 是 qmd 的官方覆盖点。
  if (!process.env.QMD_EMBED_PARALLELISM) process.env.QMD_EMBED_PARALLELISM = '1';
  const store = await createStore({ dbPath: cfg.dbPath, config: qmdCollectionConfig(vaultRoot, cfg.model) });
  cached = { key, store };
  return store;
}

/** 进程退出时释放模型与数据库连接。 */
export async function closeQmdStore(): Promise<void> {
  if (!cached) return;
  const store = cached.store;
  cached = null;
  await store.close();
}

export interface QmdSyncResult {
  /** 索引里的文档总数。 */
  documents: number;
  /** 本次新嵌入的分片数。 */
  chunksEmbedded: number;
  /** 仍待嵌入的文档数。 */
  needsEmbedding: number;
}

/** 增量重建索引：扫描文件变化，再补齐向量。 */
export async function syncQmdIndex(vaultRoot: string, cfg: QmdSearchConfig): Promise<QmdSyncResult> {
  const store = await getQmdStore(vaultRoot, cfg);
  await store.update();
  // 小批次嵌入：qmd 默认 64 篇/批，llama.cpp Metal 在这种批量下会卡在 GPU 等待里
  // （实测进程静默挂死，16GB 机器上尤其明显）。8 篇/批实测 224 篇 49 秒跑完。
  const emb = await store.embed({ maxDocsPerBatch: 8, maxBatchBytes: 128 * 1024 });
  const status = await store.getStatus();
  return {
    documents: status.totalDocuments,
    chunksEmbedded: emb.chunksEmbedded,
    needsEmbedding: status.needsEmbedding,
  };
}

/** 检索：qmd 完整管线，返回按 qmd 排序的命中。 */
export async function searchQmd(
  vaultRoot: string,
  query: string,
  cfg: QmdSearchConfig,
  opts: { categories?: readonly string[]; limit?: number } = {},
): Promise<QmdHit[]> {
  const store = await getQmdStore(vaultRoot, cfg);
  const results = await store.search({
    query,
    ...(opts.categories?.length ? { collections: [...opts.categories] } : {}),
    limit: Math.max(1, Math.min(50, opts.limit ?? cfg.limit ?? 10)),
    ...(cfg.minScore ? { minScore: cfg.minScore } : {}),
  });
  const hits: QmdHit[] = [];
  for (const r of results) {
    const path = troveRelPath(r.file) ?? troveRelPath(r.displayPath);
    if (!path) continue;
    hits.push({ path, title: r.title || path, score: r.score });
  }
  return hits;
}

/** 索引状态：文档数与待嵌入数；索引不存在或损坏返回 null。 */
export async function qmdIndexStatus(
  vaultRoot: string,
  cfg: QmdSearchConfig,
): Promise<{ documents: number; needsEmbedding: number; hasVectorIndex: boolean } | null> {
  try {
    // 索引不存在时不要顺手建一个空库出来。
    if (!existsSync(cfg.dbPath)) return null;
    const store = await getQmdStore(vaultRoot, cfg);
    const status = await store.getStatus();
    return {
      documents: status.totalDocuments,
      needsEmbedding: status.needsEmbedding,
      hasVectorIndex: status.hasVectorIndex,
    };
  } catch {
    return null;
  }
}

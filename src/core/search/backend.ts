/** 检索后端解析：learn.search → 本地 qmd 或百炼云端；关闭/缺配置返回 undefined（纯 FTS）。 */
import type { LearnConfig } from '../../config.js';
import type { TrovePaths } from '../../paths.js';
import { cloudIndexStatus, syncCloudIndex, type CloudSearchConfig } from './cloud.js';
import { qmdIndexStatus, syncQmdIndex, type QmdSearchConfig } from './qmd.js';

export type SearchBackend =
  | ({ provider: 'local' } & QmdSearchConfig)
  | ({ provider: 'dashscope' } & CloudSearchConfig);

/** 状态/日志里展示的嵌入模型名。 */
export function searchModelLabel(search: LearnConfig['search']): string {
  return search.provider === 'dashscope' ? search.dashscope.model : search.model;
}

export function searchBackendFromConfig(
  search: LearnConfig['search'],
  paths: TrovePaths,
): SearchBackend | undefined {
  if (!search.enabled) return undefined;
  if (search.provider === 'dashscope') {
    const { apiKey, baseUrl, model, dimension } = search.dashscope;
    // 缺 Key 不报错，降级纯 FTS；doctor 会显式提示补配置。
    if (!apiKey) return undefined;
    return {
      provider: 'dashscope',
      dbPath: paths.cloudVectorsDb,
      apiKey,
      baseUrl,
      model,
      dimension,
      minScore: search.minScore,
    };
  }
  return {
    provider: 'local',
    dbPath: paths.qmdDb,
    model: search.model,
    host: search.host,
    minScore: search.minScore,
  };
}

export interface SearchIndexStatus {
  documents: number;
  needsEmbedding: number;
}

/** 索引状态；索引不存在返回 null。 */
export async function searchIndexStatus(
  vaultRoot: string,
  backend: SearchBackend,
): Promise<SearchIndexStatus | null> {
  return backend.provider === 'dashscope'
    ? cloudIndexStatus(backend)
    : qmdIndexStatus(vaultRoot, backend);
}

/** 增量同步索引；两个后端返回同形结果。 */
export async function syncSearchBackendIndex(
  vaultRoot: string,
  backend: SearchBackend,
): Promise<{ documents: number; chunksEmbedded: number; needsEmbedding: number }> {
  return backend.provider === 'dashscope'
    ? syncCloudIndex(vaultRoot, backend)
    : syncQmdIndex(vaultRoot, backend);
}
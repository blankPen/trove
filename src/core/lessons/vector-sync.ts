/** 向量索引增量同步：扫描磁盘记忆，按 updated_at 只重编码变更项。 */
import { libraryLessonsDir } from '../layout.js';
import { listMemoryFiles } from './curator.js';
import { embedText, isEmbeddableText } from './embedding.js';
import type { Embedder } from './embedding.js';
import { LocalStorageAdapter } from './storage.js';
import { VectorIndex } from './vector-index.js';

export interface VectorSyncResult {
  indexed: number;
  removed: number;
  skipped: number;
}

export async function syncVectorIndex(
  vaultRoot: string,
  index: VectorIndex,
  embedder: Embedder,
): Promise<VectorSyncResult> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const files = await listMemoryFiles(storage);
  const disk = new Map<string, { path: string; scope: string; text: string; ts: number }>();
  for (const f of files) {
    if (!f.memory.id) continue;
    disk.set(f.memory.id, {
      path: f.path,
      scope: f.memory.scope,
      text: embedText(f.memory),
      ts: Date.parse(f.memory.updatedAt) || 0,
    });
  }

  const existing = new Map(index.all().map((r) => [r.memoryId, r]));
  let removed = 0;
  for (const id of existing.keys()) {
    if (!disk.has(id)) {
      index.remove(id);
      removed++;
    }
  }

  const toEncode: Array<{ id: string; path: string; scope: string; text: string; ts: number }> = [];
  let skipped = 0;
  for (const [id, f] of disk) {
    if (!isEmbeddableText(f.text)) {
      if (existing.has(id)) {
        index.remove(id);
        removed++;
      }
      skipped++;
      continue;
    }
    const prev = existing.get(id);
    // updated_at 无效（ts=0）时总是重编码，避免漏掉正文变更。
    if (prev && f.ts !== 0 && prev.updatedAt === f.ts) continue;
    toEncode.push({ id, path: f.path, scope: f.scope, text: f.text, ts: f.ts });
  }

  if (toEncode.length > 0) {
    const vecs = await embedder.encode(toEncode.map((t) => t.text));
    for (let i = 0; i < toEncode.length; i++) {
      const t = toEncode[i]!;
      const v = vecs[i];
      if (!v) continue;
      index.upsert(t.id, t.path, t.scope, v, t.ts);
    }
  }
  return { indexed: toEncode.length, removed, skipped };
}

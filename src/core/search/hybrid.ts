/** 混合召回：FTS5 + 向量余弦，RRF 融合。向量不可用时回退纯 FTS。 */
import type { Embedder } from '../lessons/embedding.js';
import type { VectorIndex } from '../lessons/vector-index.js';
import type { LessonDoc, LessonHit, LessonQuery, LessonsIndex } from './lessons-index.js';
import { clip } from './rank.js';

export interface RrfOptions {
  rrfK?: number;
}

/** RRF：score = Σ 1/(rrfK + rank)，rank 从 1 起；同 id 跨列表分数累加。 */
export function rrfFuse<T extends { id: string }>(lists: T[][], opts: RrfOptions = {}): Array<T & { score: number }> {
  const k = opts.rrfK ?? 60;
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      const add = 1 / (k + (i + 1));
      const cur = scores.get(item.id);
      if (cur) cur.score += add;
      else scores.set(item.id, { item, score: add });
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, score }));
}

export interface HybridDeps {
  index: LessonsIndex;
  embedder: Embedder | null;
  vectors: VectorIndex | null;
  recallTopK?: number;
  rrfK?: number;
  /** 向量最低余弦相似度;低于此值不进入融合(短问句常出现无相关内容却硬凑)。 */
  minScore?: number;
}

/** 向量缺失/失败一律回退 FTS，绝不阻断检索。 */
export async function searchLessonsHybrid(
  vaultRoot: string,
  query: string,
  opts: LessonQuery,
  deps: HybridDeps,
): Promise<LessonHit[]> {
  const fts = deps.index.search(opts);
  if (!deps.embedder || !deps.vectors) return fts;
  const q = query.trim();
  if (!q) return fts;

  let vecPaths: Array<{ id: string }>;
  try {
    const [qv] = await deps.embedder.encode([q]);
    if (!qv) return fts;
    vecPaths = deps.vectors
      .search(qv, deps.recallTopK ?? 10)
      .filter((h) => deps.minScore === undefined || h.score >= deps.minScore)
      .map((h) => ({ id: h.path }));
  } catch {
    return fts;
  }

  const fused = rrfFuse([fts.map((h) => ({ id: h.path })), vecPaths], { rrfK: deps.rrfK ?? 60 });
  const byPath = new Map(fts.map((h) => [h.path, h]));
  const out: LessonHit[] = [];
  for (const r of fused) {
    const hit = byPath.get(r.id) ?? hitFromDoc(deps.index.get(r.id));
    if (hit) out.push(hit);
  }
  return out.slice(0, Math.max(1, Math.min(50, opts.limit ?? 10)));
}

function hitFromDoc(doc: LessonDoc | null): LessonHit | null {
  if (!doc) return null;
  return {
    path: doc.path,
    title: doc.title,
    type: doc.type,
    tags: doc.tags,
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
    ...(doc.id ? { id: doc.id } : {}),
    ...(doc.scope ? { scope: doc.scope } : {}),
    snippet: clip(doc.body, 160),
    score: 0,
    scoreParts: { bm25: 0, recency: 0, exact: 0, project: 0 },
  };
}

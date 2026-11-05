/** Review inbox:候选经验在 review 模式下先落 `.trove/inbox/<id>.json`,由人 accept/reject 后再进合并写盘。 */
import type { StorageAdapter } from './storage.js';
import type { DecisionGateway } from './gateway.js';
import type { LlmProvider } from './llm.js';
import type { LearnConfig } from '../../config.js';
import type { EvidenceRef, QualityScore } from './memory.js';
import { newMemoryId } from './memory.js';
import type { MemoryCandidateV2 } from './extract.js';
import { mergeMemoriesV2 } from './merge.js';
import { loadExistingForGate } from './existing.js';
import { applyCapacity, DEFAULT_CAPACITY } from './capacity.js';
import { applyOperations } from './write.js';
import { appendDecision } from './decisions.js';
import { recordReview } from './trust.js';

export interface InboxItem {
  id: string; // inbox_...
  session: string;
  type: string;
  title: string;
  content: string; // 五段式(证据段由写盘补)
  evidence: EvidenceRef[];
  scope?: string;
  quality?: QualityScore;
  confidence?: number;
  trajectoryId?: string;
  promptVersion: string;
  createdAt: string;
}

const INBOX_DIR = '.trove/inbox';

/** 只允许 `[A-Za-z0-9_-]+`,防路径穿越。 */
function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function itemPath(id: string): string {
  return `${INBOX_DIR}/${id}.json`;
}

export function newInboxId(now?: Date): string {
  return newMemoryId('inbox_', now);
}

export async function writeInboxItem(storage: StorageAdapter, item: InboxItem): Promise<string> {
  if (!validId(item.id)) throw new Error(`非法 inbox id: ${item.id}`);
  await storage.write(itemPath(item.id), JSON.stringify(item, null, 2));
  return item.id;
}

/** 按 createdAt 升序;损坏文件跳过不抛。 */
export async function listInbox(storage: StorageAdapter, filter?: { session?: string }): Promise<InboxItem[]> {
  const files = await storage.list(INBOX_DIR);
  const out: InboxItem[] = [];
  for (const path of files) {
    const id = (path.split('/').pop() ?? '').replace(/\.json$/, '');
    if (!validId(id)) continue;
    const it = await readInboxItem(storage, id);
    if (it && (!filter?.session || it.session === filter.session)) out.push(it);
  }
  return out.sort((a, b) => (a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0));
}

export async function readInboxItem(storage: StorageAdapter, id: string): Promise<InboxItem | null> {
  if (!validId(id)) return null;
  const text = await storage.read(itemPath(id));
  if (text === null) return null;
  try {
    const r = JSON.parse(text) as InboxItem;
    return typeof r?.id === 'string' && typeof r?.content === 'string' ? r : null;
  } catch {
    return null;
  }
}

export async function removeInboxItem(storage: StorageAdapter, id: string): Promise<void> {
  if (!validId(id)) return;
  await storage.delete(itemPath(id));
}

export async function updateInboxItem(
  storage: StorageAdapter,
  id: string,
  patch: { title?: string; content?: string },
): Promise<InboxItem | null> {
  const it = await readInboxItem(storage, id);
  if (!it) return null;
  const next: InboxItem = {
    ...it,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
  };
  await storage.write(itemPath(id), JSON.stringify(next, null, 2));
  return next;
}

/** 读 item → 转候选 → Gate C 合并 → 容量检查 → 写盘;ops 为空(重复)也删除并记录。容量拒绝时保留 item。 */
export async function acceptInboxItem(
  storage: StorageAdapter,
  id: string,
  deps: { gateway: DecisionGateway; llm: LlmProvider; learn: LearnConfig; now?: () => Date },
): Promise<{ paths: string[]; removed: boolean; reason?: string }> {
  const it = await readInboxItem(storage, id);
  if (!it) return { paths: [], removed: false };
  const now = deps.now ?? (() => new Date());
  const candidate: MemoryCandidateV2 = {
    type: it.type,
    title: it.title,
    content: it.content,
    evidence: it.evidence,
    quality: it.quality,
    confidence: it.confidence,
    sourceTrajectories: it.trajectoryId ? [it.trajectoryId] : undefined,
    ...(it.scope ? { scope: it.scope } : {}),
  };
  const existing = await loadExistingForGate(storage);
  const ops = await mergeMemoriesV2([candidate], existing, { gateway: deps.gateway, llm: deps.llm, learn: deps.learn });
  const capacityResult = applyCapacity(ops, existing, deps.learn.capacity ?? DEFAULT_CAPACITY);
  if (capacityResult.rejected.length > 0) {
    return { paths: [], removed: false, reason: capacityResult.rejected[0]!.decision.reason };
  }
  const res = await applyOperations(capacityResult.ops, { storage, now: deps.now, source: it.session });
  await appendDecision(storage, {
    at: now().toISOString(),
    session: it.session,
    stage: 'review',
    decision: 'accepted',
    source: 'human',
    reasons: [],
    candidate: { type: it.type, title: it.title },
    promptVersion: it.promptVersion,
  });
  await removeInboxItem(storage, id);
  await recordReview(storage, 'accepted', deps.now);
  return { paths: [...res.added, ...res.updated, ...res.appended], removed: true };
}

export async function rejectInboxItem(storage: StorageAdapter, id: string, _reason?: string): Promise<boolean> {
  const it = await readInboxItem(storage, id);
  if (!it) return false;
  await appendDecision(storage, {
    at: new Date().toISOString(),
    session: it.session,
    stage: 'review',
    decision: 'rejected',
    source: 'human',
    reasons: [{ question: 'human', probability: 0 }],
    candidate: { type: it.type, title: it.title },
    promptVersion: it.promptVersion,
  });
  await removeInboxItem(storage, id);
  await recordReview(storage, 'rejected');
  return true;
}

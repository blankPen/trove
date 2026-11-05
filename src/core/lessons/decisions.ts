/** 决策日志:每步裁决追加到 `.trove/decisions.jsonl`(相对 lessons 根),单写者全量读写。 */
import type { StorageAdapter } from './storage.js';

export type DecisionSource = 'heuristic' | 'jev' | 'llm' | 'human';

export interface DecisionReason {
  question: string;
  probability: number;
}

export interface DecisionRecord {
  at: string;
  session: string;
  stage: 'triage' | 'screen' | 'identity' | 'quality' | 'adjudicate' | 'skip';
  gate?: 'A' | 'B' | 'C';
  decision: string;
  source: DecisionSource;
  reasons: DecisionReason[];
  candidate?: { type: string; title: string };
  target?: string;
  model?: string;
  promptVersion?: string;
}

const DECISIONS_PATH = '.trove/decisions.jsonl';

export async function appendDecision(storage: StorageAdapter, r: DecisionRecord): Promise<void> {
  const existing = (await storage.read(DECISIONS_PATH)) ?? '';
  await storage.write(DECISIONS_PATH, existing + JSON.stringify(r) + '\n');
}

export async function readDecisions(storage: StorageAdapter, filter?: { session?: string }): Promise<DecisionRecord[]> {
  const text = await storage.read(DECISIONS_PATH);
  if (text === null) return [];
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过
    }
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as DecisionRecord;
    if (filter?.session && rec.session !== filter.session) continue;
    out.push(rec);
  }
  return out;
}

/** 信任阶梯:人类 review 行为的累积信任。L0→L1→L2 按规则自动升级,L2→L3 只能人工显式设置;只升不降。 */
import type { StorageAdapter } from './storage.js';

export type TrustLevel = 0 | 1 | 2 | 3;

export interface TrustState {
  level: TrustLevel;
  accepted: number;
  rejected: number;
  /** 当前 level 的起始时间 ISO;用于 2 周观察期。 */
  since: string;
  updatedAt: string;
  lastRejectedAt?: string;
}

const TRUST_PATH = '.trove/trust.json';
const DAY = 24 * 60 * 60 * 1000;

function defaultState(now: Date): TrustState {
  return { level: 0, accepted: 0, rejected: 0, since: now.toISOString(), updatedAt: now.toISOString() };
}

export async function readTrust(storage: StorageAdapter, now: () => Date = () => new Date()): Promise<TrustState> {
  const text = await storage.read(TRUST_PATH);
  if (text === null) return defaultState(now());
  try {
    const r = JSON.parse(text) as Partial<TrustState>;
    const level = r.level === 1 || r.level === 2 || r.level === 3 ? r.level : 0;
    return {
      level,
      accepted: typeof r.accepted === 'number' && Number.isFinite(r.accepted) ? r.accepted : 0,
      rejected: typeof r.rejected === 'number' && Number.isFinite(r.rejected) ? r.rejected : 0,
      since: typeof r.since === 'string' ? r.since : now().toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now().toISOString(),
      ...(typeof r.lastRejectedAt === 'string' ? { lastRejectedAt: r.lastRejectedAt } : {}),
    };
  } catch {
    return defaultState(now()); // 损坏回退默认
  }
}

export async function writeTrust(storage: StorageAdapter, s: TrustState): Promise<void> {
  await storage.write(TRUST_PATH, JSON.stringify(s, null, 2));
}

/** 只升不降;升级时 since=now。每次调用至多升一级(升级后 since 重置,14 天观察期重新计时)。 */
export function evaluateTrust(s: TrustState, now: Date): TrustState {
  const ageMs = now.getTime() - Date.parse(s.since);
  const acceptRate = s.accepted + s.rejected === 0 ? 0 : s.accepted / (s.accepted + s.rejected);
  if (s.level === 0 && s.accepted >= 30 && acceptRate >= 0.8 && ageMs >= 14 * DAY) {
    return { ...s, level: 1, since: now.toISOString(), updatedAt: now.toISOString() };
  }
  if (s.level === 1 && ageMs >= 14 * DAY && !(s.lastRejectedAt && now.getTime() - Date.parse(s.lastRejectedAt) < 14 * DAY)) {
    return { ...s, level: 2, since: now.toISOString(), updatedAt: now.toISOString() };
  }
  return s; // L2→L3 不自动,由 CLI 显式设置
}

/** 记录一次人类 review 行为,自动评估升级并持久化。 */
export async function recordReview(
  storage: StorageAdapter,
  outcome: 'accepted' | 'rejected',
  now: () => Date = () => new Date(),
): Promise<TrustState> {
  const t = now();
  const cur = await readTrust(storage, now);
  const next: TrustState = {
    ...cur,
    accepted: cur.accepted + (outcome === 'accepted' ? 1 : 0),
    rejected: cur.rejected + (outcome === 'rejected' ? 1 : 0),
    updatedAt: t.toISOString(),
    ...(outcome === 'rejected' ? { lastRejectedAt: t.toISOString() } : {}),
  };
  const evaluated = evaluateTrust(next, t);
  await writeTrust(storage, evaluated);
  return evaluated;
}

import type { HarnessId } from '../../adapters/index.js';

/** library 里的会话变体:同一 (harness, session) 来自一台设备的一份事件流。 */
export interface SessionVariant {
  device: string;
  /** 相对 library 根: sessions/<harness>/<session>/<device>.jsonl */
  path: string;
  hash: string;
  events: number;
}

/** 统一索引里的会话条目(合并后的视图)。 */
export interface MergedSession {
  harness: HarnessId;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  canonical: SessionVariant;
  variants: SessionVariant[];
  /** 参与的设备 */
  sources: string[];
}

/** 每设备发布的索引分片。 */
export interface IndexShard {
  v: 1;
  device: string;
  mapper: string;
  updatedAt: string;
  sessions: Record<string, SessionVariant & { title?: string; firstText?: string; cwd?: string; model?: string; startedAt?: string; rawSources: string[] }>;
  skills: Record<string, SkillEntry>;
}

export type SkillSource = 'self' | 'github' | 'skillsh' | 'unknown';

export interface SkillFile {
  /** 相对 skill 版本目录 */
  rel: string;
  size: number;
}

export interface SkillEntry {
  name: string;
  hash: string;
  version?: string;
  source: SkillSource;
  origin?: string;
  updatedAt?: string;
  /** 版本目录内的文件清单: versions/<name>/<hash>/<rel> */
  files: SkillFile[];
}

export interface MergedSkill {
  name: string;
  latest: string;
  versions: Array<SkillEntry & { devices: string[] }>;
}

export interface LibraryIndex {
  v: 1;
  generatedAt: string;
  hash: string;
  sessions: Record<string, MergedSession>;
  skills: Record<string, MergedSkill>;
}

export function sessionKeyOf(harness: string, session: string): string {
  return `${harness}:${session}`;
}


/** 技能版本比较:能解析 semver 的优先,semver 大的更新;都不能解析返回 0。 */
export function compareVersions(a?: string, b?: string): number {
  const parse = (v?: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
    return 0;
  }
  if (pa) return 1;
  if (pb) return -1;
  return 0;
}

/** 从候选版本里选“最新”:semver → updatedAt → hash,保证确定性。 */
export function pickLatestHash(
  versions: Array<{ hash: string; version?: string; updatedAt?: string }>,
): string {
  const sorted = [...versions].sort((a, b) => {
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
    const t = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    if (t !== 0) return t;
    return a.hash.localeCompare(b.hash);
  });
  return sorted[0]!.hash;
}

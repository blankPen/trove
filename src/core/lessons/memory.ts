/** 记忆 schema v2:旧 v1 文件仍可读,新文件带 id/kind/status/version/quality/evidence 等字段。 */
import { splitFrontmatter } from './frontmatter.js';

export type MemoryKind = 'experience' | 'preference' | 'entity' | 'event' | 'resource' | 'trajectory';
export type MemoryStatus = 'candidate' | 'active' | 'stale' | 'archived' | 'superseded';

export interface QualityScore {
  specific: number;
  actionable: number;
  transferable: number;
  evidence: number;
  non_duplicate: number;
}

export interface EvidenceRef {
  session: string;
  seq: number;
  quote: string;
  path?: string;
  line?: number;
}

export interface MemoryV2 {
  id: string;
  kind: MemoryKind;
  type: string;
  title: string;
  tags: string[];
  scope: string;
  status: MemoryStatus;
  version: number;
  confidence?: number;
  quality?: QualityScore;
  evidence: EvidenceRef[];
  sourceTrajectories?: string[];
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  useCount: number;
  helpfulCount: number;
  promptVersion?: string;
  body: string;
}

/** Crockford Base32(去 I/L/O/U),与 ULID 同源。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成 `prefix` + ULID 风格 26 字符(10 位毫秒时间 + 16 位随机),同毫秒不同 random 也唯一,字典序随时间递增。 */
export function newMemoryId(prefix: string, now?: Date, random: () => number = Math.random): string {
  let ms = (now ?? new Date()).getTime();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32]! + time;
    ms = Math.floor(ms / 32);
  }
  let rnd = '';
  for (let i = 0; i < 16; i++) {
    const n = Math.floor(Math.max(0, Math.min(0.9999999999999999, random())) * 32);
    rnd += CROCKFORD[n]!;
  }
  return prefix + time + rnd;
}

/** 由 type 一级目录前缀推断 id 前缀;未知前缀按通用 mem_ 兜底。 */
export function idPrefix(type: string): string {
  switch (type.split('/')[0]) {
    case 'experiences': return 'exp_';
    case 'preferences': return 'pref_';
    case 'entities': return 'ent_';
    case 'events': return 'evt_';
    case 'resources': return 'res_';
    case 'trajectories': return 'traj_';
    default: return 'mem_';
  }
}

/** 由 type 一级目录前缀推断 kind;未知前缀按经验处理(旧文件的兜底)。 */
export function inferKind(type: string): MemoryKind {
  const prefix = type.split('/')[0];
  switch (prefix) {
    case 'experiences':
      return 'experience';
    case 'preferences':
      return 'preference';
    case 'entities':
      return 'entity';
    case 'events':
      return 'event';
    case 'resources':
      return 'resource';
    case 'trajectories':
      return 'trajectory';
    default:
      return 'experience';
  }
}

/** 渲染成 v2 frontmatter:每字段一行,字符串 JSON 序列化,evidence 空写 [];可选字段缺省不写。 */
export function renderMemory(m: MemoryV2): string {
  const lines = [
    '---',
    `id: ${JSON.stringify(m.id)}`,
    `kind: ${m.kind}`,
    `type: ${m.type}`,
    `title: ${JSON.stringify(m.title)}`,
    `tags: ${JSON.stringify(m.tags)}`,
    `scope: ${m.scope}`,
    `status: ${m.status}`,
    `version: ${m.version}`,
  ];
  if (m.confidence !== undefined) lines.push(`confidence: ${JSON.stringify(m.confidence)}`);
  if (m.quality !== undefined) lines.push(`quality: ${JSON.stringify(m.quality)}`);
  lines.push(`evidence: ${JSON.stringify(m.evidence ?? [])}`);
  if (m.sourceTrajectories !== undefined && m.sourceTrajectories.length > 0) {
    lines.push(`source_trajectories: ${JSON.stringify(m.sourceTrajectories)}`);
  }
  if (m.supersedes !== undefined && m.supersedes !== '') lines.push(`supersedes: ${JSON.stringify(m.supersedes)}`);
  lines.push(`created_at: ${JSON.stringify(m.createdAt)}`);
  lines.push(`updated_at: ${JSON.stringify(m.updatedAt)}`);
  if (m.lastUsedAt !== undefined && m.lastUsedAt !== null) lines.push(`last_used_at: ${JSON.stringify(m.lastUsedAt)}`);
  lines.push(`use_count: ${m.useCount}`);
  lines.push(`helpful_count: ${m.helpfulCount}`);
  if (m.promptVersion !== undefined && m.promptVersion !== '') lines.push(`prompt_version: ${JSON.stringify(m.promptVersion)}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${m.body}`;
}

const KINDS: MemoryKind[] = ['experience', 'preference', 'entity', 'event', 'resource', 'trajectory'];
const STATUSES: MemoryStatus[] = ['candidate', 'active', 'stale', 'archived', 'superseded'];

/** 解析 v2 记忆;缺 id/kind/status/version/quality 的旧文件也返回(补默认),无 type 返回 null。损坏字段回退默认,不抛。 */
export function parseMemory(text: string): MemoryV2 | null {
  const split = splitFrontmatter(text);
  if (!split) return null;
  const fields = readFields(split.block);
  const type = fields['type'];
  if (!type) return null;
  return {
    id: str(fields['id'], ''),
    kind: parseKind(fields['kind'], type),
    type,
    title: str(fields['title'], ''),
    tags: strArray(fields['tags']),
    scope: str(fields['scope'], 'global'),
    status: parseStatus(fields['status']),
    version: int(fields['version'], 1),
    confidence: numOpt(fields['confidence']),
    quality: parseQuality(fields['quality']),
    evidence: parseEvidence(fields['evidence']),
    sourceTrajectories: strArrayOpt(fields['source_trajectories']),
    supersedes: strOpt(fields['supersedes']) ?? strOpt(fields['superseded_by']),
    createdAt: str(fields['created_at'], ''),
    updatedAt: str(fields['updated_at'], ''),
    lastUsedAt: lastUsed(fields['last_used_at']),
    useCount: int(fields['use_count'], 0),
    helpfulCount: int(fields['helpful_count'], 0),
    promptVersion: strOpt(fields['prompt_version']),
    // renderMemory 在 `---` 后留一行空行;splitFrontmatter 只剥掉换行,这里再剥掉空行。
    body: split.body.replace(/^\n/, ''),
  };
}

/** 加权总质量分:evidence 权重最高(0.30)。 */
export function qualityTotal(q: QualityScore): number {
  return 0.2 * q.specific + 0.2 * q.actionable + 0.15 * q.transferable + 0.3 * q.evidence + 0.15 * q.non_duplicate;
}

function readFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/);
    if (m) fields[m[1]!] = m[2]!;
  }
  return fields;
}

/** JSON 解析,失败回退原始字符串(与 frontmatter.parseJson 同口径)。 */
function parseJson(v: string | undefined): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function str(v: string | undefined, fallback: string): string {
  const p = parseJson(v);
  return typeof p === 'string' ? p : fallback;
}

function strOpt(v: string | undefined): string | undefined {
  const p = parseJson(v);
  return typeof p === 'string' ? p : undefined;
}

function int(v: string | undefined, fallback: number): number {
  const p = parseJson(v);
  return typeof p === 'number' && Number.isFinite(p) ? p : fallback;
}

function numOpt(v: string | undefined): number | undefined {
  const p = parseJson(v);
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

function strArray(v: string | undefined): string[] {
  const p = parseJson(v);
  return Array.isArray(p) ? p.map(String) : [];
}

function strArrayOpt(v: string | undefined): string[] | undefined {
  const p = parseJson(v);
  return Array.isArray(p) ? p.map(String) : undefined;
}

function parseKind(v: string | undefined, type: string): MemoryKind {
  const p = parseJson(v);
  return (KINDS as string[]).includes(p as string) ? (p as MemoryKind) : inferKind(type);
}

function parseStatus(v: string | undefined): MemoryStatus {
  const p = parseJson(v);
  return (STATUSES as string[]).includes(p as string) ? (p as MemoryStatus) : 'active';
}

function parseQuality(v: string | undefined): QualityScore | undefined {
  const p = parseJson(v);
  if (typeof p !== 'object' || p === null) return undefined;
  const r = p as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : NaN);
  const q = {
    specific: n('specific'),
    actionable: n('actionable'),
    transferable: n('transferable'),
    evidence: n('evidence'),
    non_duplicate: n('non_duplicate'),
  };
  return Object.values(q).every(Number.isFinite) ? q : undefined;
}

function parseEvidence(v: string | undefined): EvidenceRef[] {
  const p = parseJson(v);
  if (!Array.isArray(p)) return [];
  const out: EvidenceRef[] = [];
  for (const item of p) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const seq = typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : NaN;
    if (!Number.isFinite(seq)) continue;
    out.push({
      session: typeof r.session === 'string' ? r.session : '',
      seq,
      quote: typeof r.quote === 'string' ? r.quote : '',
      ...(typeof r.path === 'string' ? { path: r.path } : {}),
      ...(typeof r.line === 'number' ? { line: r.line } : {}),
    });
  }
  return out;
}

function lastUsed(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const p = parseJson(v);
  if (typeof p === 'string') return p;
  if (p === null) return null;
  return undefined;
}

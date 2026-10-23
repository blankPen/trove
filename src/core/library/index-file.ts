import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HarnessId } from '../../adapters/index.js';
import { libraryDir, libraryIndexDir, libraryMergedRelPath, librarySkillsDir } from '../layout.js';
import type { Event } from '../events/schema.js';
import { pickLatestHash } from './schema.js';
import type {
  IndexShard,
  LibraryIndex,
  MergedSession,
  MergedSkill,
  SessionVariant,
  SkillEntry,
} from './schema.js';

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 递归排序对象 key,保证索引字节稳定、可 hash。 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObj(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

async function readShards(vaultRoot: string): Promise<IndexShard[]> {
  const dir = libraryIndexDir(vaultRoot);
  const out: IndexShard[] = [];
  for (const name of await safeReaddir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as IndexShard;
      if (parsed && parsed.v === 1 && isObj(parsed.sessions)) out.push(parsed);
    } catch {
      // 损坏分片忽略;下次构建会重写
    }
  }
  return out;
}

interface SessionItem {
  entry: IndexShard['sessions'][string];
  variant: SessionVariant;
}

function chooseSession(items: SessionItem[]): Omit<MergedSession, 'harness' | 'session'> {
  const sorted = [...items].sort((a, b) => a.variant.device.localeCompare(b.variant.device));
  const variants = sorted.map((i) => i.variant);
  const hashes = new Set(variants.map((v) => v.hash));
  const canonical =
    variants.length === 1 || hashes.size === 1
      ? variants[0]!
      : [...variants].sort((a, b) => b.events - a.events || a.hash.localeCompare(b.hash))[0]!;
  const meta = sorted.find((i) => i.variant === canonical)!.entry;
  return {
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.firstText ? { firstText: meta.firstText } : {}),
    ...(meta.cwd ? { cwd: meta.cwd } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
    canonical,
    variants: variants.filter((v) => v !== canonical),
    sources: sorted.map((i) => i.variant.device),
  };
}

function eventIdentity(e: Event): string {
  if (e.kind === 'session') return 'session';
  if (e.id) return `${e.kind}|${e.id}`;
  const payload = JSON.stringify([e.text ?? '', e.tool ?? null, e.result ?? null]);
  const h = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `${e.kind}|${e.ts}|${h}`;
}

/**
 * 同一个豆包会话在两台设备各持一半时,按事件身份求并集。
 * 结果按内容寻址落盘:不同设备算出的同一并集得到同一路径,互不覆盖。
 */
async function mergeDoubaoVariants(
  vaultRoot: string,
  items: SessionItem[],
): Promise<SessionVariant | null> {
  const events: Event[] = [];
  const seen = new Set<string>();
  let header: Event | null = null;

  for (const item of items) {
    let text: string;
    try {
      text = await readFile(join(libraryDir(vaultRoot), ...item.variant.path.split('/')), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        continue;
      }
      if (e.kind === 'session') {
        header ??= e;
        continue;
      }
      const key = eventIdentity(e);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(e);
    }
  }
  if (!header) return null;

  events.sort((a, b) => (a.ts || '9999').localeCompare(b.ts || '9999') || a.seq - b.seq);
  const merged: Event[] = [
    {
      ...header,
      sources: [...new Set(items.map((i) => i.variant.device))].sort(),
      extra: { ...(header.extra ?? {}), merged: true },
    },
    ...events.map((e, i) => ({ ...e, seq: i + 1 })),
  ];
  const body = merged.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const hash = createHash('sha256').update(body).digest('hex');
  const rel = libraryMergedRelPath(header.harness, header.session, hash);
  const abs = join(libraryDir(vaultRoot), ...rel.split('/'));
  try {
    await readFile(abs);
  } catch {
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, abs);
  }
  return { device: 'merged', path: rel, hash, events: merged.length };
}

async function readSkillMeta(
  vaultRoot: string,
): Promise<Array<{ name: string; device: string; versions: SkillEntry[] }>> {
  const root = librarySkillsDir(vaultRoot);
  const out: Array<{ name: string; device: string; versions: SkillEntry[] }> = [];
  for (const name of await safeReaddir(root)) {
    for (const file of await safeReaddir(join(root, name, 'meta'))) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(root, name, 'meta', file), 'utf8')) as {
          name?: string;
          device?: string;
          versions?: SkillEntry[];
        };
        if (parsed.name && Array.isArray(parsed.versions)) {
          out.push({
            name: parsed.name,
            device: parsed.device ?? file.replace(/\.json$/, ''),
            versions: parsed.versions,
          });
        }
      } catch {
        // 损坏 meta 忽略
      }
    }
  }
  return out;
}

async function mergeSkills(vaultRoot: string): Promise<Record<string, MergedSkill>> {
  const metas = await readSkillMeta(vaultRoot);
  const bySkill = new Map<string, Map<string, SkillEntry & { devices: Set<string> }>>();
  for (const meta of metas) {
    const versions = bySkill.get(meta.name) ?? new Map();
    for (const v of meta.versions) {
      const cur = versions.get(v.hash) ?? { ...v, devices: new Set<string>() };
      cur.devices.add(meta.device);
      versions.set(v.hash, cur);
    }
    bySkill.set(meta.name, versions);
  }

  const out: Record<string, MergedSkill> = {};
  for (const name of [...bySkill.keys()].sort()) {
    const versions = [...bySkill.get(name)!.values()]
      .map((v) => ({ ...v, devices: [...v.devices].sort() }))
      .sort((a, b) => a.hash.localeCompare(b.hash));
    out[name] = { name, latest: pickLatestHash(versions), versions };
  }
  return out;
}

/**
 * 合并 `library/index/*.json` 分片与技能 meta,生成统一索引。
 * 索引是派生物:任何冲突都以"选 canonical + 保留 variants"收尾,不覆盖数据。
 */
export async function rebuildUnifiedIndex(vaultRoot: string): Promise<LibraryIndex> {
  const shards = await readShards(vaultRoot);
  const grouped = new Map<string, SessionItem[]>();

  for (const shard of shards) {
    for (const [key, entry] of Object.entries(shard.sessions)) {
      const item: SessionItem = {
        entry,
        variant: { device: shard.device, path: entry.path, hash: entry.hash, events: entry.events },
      };
      const list = grouped.get(key) ?? [];
      list.push(item);
      grouped.set(key, list);
    }
  }

  const sessions: Record<string, MergedSession> = {};
  for (const key of [...grouped.keys()].sort()) {
    const sep = key.indexOf(':');
    const harness = key.slice(0, sep) as HarnessId;
    const items = grouped.get(key)!;
    const chosen = chooseSession(items);
    if (harness === 'doubao' && new Set(items.map((i) => i.variant.hash)).size > 1) {
      const union = await mergeDoubaoVariants(vaultRoot, items);
      if (union) {
        sessions[key] = {
          harness,
          session: key.slice(sep + 1),
          ...chosen,
          canonical: union,
          variants: items.map((i) => i.variant),
        };
        continue;
      }
    }
    sessions[key] = {
      harness,
      session: key.slice(sep + 1),
      ...chosen,
    };
  }

  const skills = await mergeSkills(vaultRoot);
  const index: LibraryIndex = {
    v: 1,
    generatedAt: new Date().toISOString(),
    hash: '',
    sessions,
    skills,
  };
  const body = JSON.stringify(stable(index));
  index.hash = createHash('sha256').update(body).digest('hex');

  const target = join(libraryDir(vaultRoot), 'index.json');
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(stable(index), null, 2) + '\n', 'utf8');
  await rename(tmp, target);
  return index;
}

export async function loadLibraryIndex(vaultRoot: string): Promise<LibraryIndex | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(libraryDir(vaultRoot), 'index.json'), 'utf8'),
    ) as LibraryIndex;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

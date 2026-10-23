import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HarnessId } from '../../adapters/index.js';
import { librarySkillsDir, rawDeviceDir, safeSessionName } from '../layout.js';
import type { State } from '../state.js';
import { pickLatestHash, type SkillEntry, type SkillSource } from './schema.js';

const SKILL_HARNESSES: HarnessId[] = ['claude-code', 'codex'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);

interface SkillFileBuffer {
  rel: string;
  bytes: Buffer;
}

async function walk(root: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walk(root, p)));
    } else if (e.isFile()) {
      if (e.name === '.DS_Store') continue;
      out.push(p);
    }
  }
  return out;
}

/** 解析 SKILL.md 的简单 frontmatter(不引入 YAML 依赖)。 */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/** 从 .git/config 里取 origin URL。 */
export function parseOrigin(gitConfig: string): string | undefined {
  const m = /\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/.exec(gitConfig);
  return m?.[1]?.trim();
}

export function classifySource(origin?: string, declared?: string): SkillSource {
  if (declared === 'github' || declared === 'skillsh' || declared === 'self') return declared;
  if (!origin) return 'self';
  if (/github\.com/i.test(origin)) return 'github';
  if (/skills?\.sh/i.test(origin)) return 'skillsh';
  return 'unknown';
}

function contentHash(files: SkillFileBuffer[]): string {
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.rel).update('\0').update(f.bytes).update('\0');
  }
  return hash.digest('hex');
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

export interface BuildSkillsOptions {
  vaultRoot: string;
  deviceId: string;
  state: State;
  now?: () => number;
}

export interface BuildSkillsResult {
  /** 每个技能的最新版本(供索引分片展示) */
  entries: Record<string, SkillEntry>;
  versions: number;
  written: number;
}

/**
 * 从本设备 raw 里的 `skills/**` 汇总技能:
 *   library/skills/<name>/versions/<hash>/…   内容寻址,保留各版本
 *   library/skills/<name>/meta/<device>.json  本设备看到的版本与来源
 * 同名按内容 hash 去重,来源由 frontmatter / .git/config 判定。
 */
export async function buildSkills(opts: BuildSkillsOptions): Promise<BuildSkillsResult> {
  const { vaultRoot, deviceId, state } = opts;
  const now = opts.now ?? Date.now;
  const byName = new Map<string, Map<string, SkillEntry>>();
  let written = 0;

  for (const harness of SKILL_HARNESSES) {
    const root = join(rawDeviceDir(vaultRoot, deviceId), harness, 'skills');
    let dirs;
    try {
      dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const skillRoot = join(root, dir.name);
      const relFiles = (await walk(skillRoot)).sort();
      if (!relFiles.length) continue;

      const files: SkillFileBuffer[] = [];
      for (const rel of relFiles) {
        files.push({ rel, bytes: await readFile(join(skillRoot, rel)) });
      }
      const hash = contentHash(files);

      const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.rel));
      const fm = skillMd ? parseFrontmatter(skillMd.bytes.toString('utf8')) : {};
      // .git 不进入版本目录,但来源判定需要读它的 origin
      let origin: string | undefined;
      try {
        origin = parseOrigin(await readFile(join(skillRoot, '.git/config'), 'utf8'));
      } catch {
        origin = undefined;
      }
      const name = fm['name'] || dir.name;
      const source = classifySource(origin, fm['source']);
      const version = fm['version'] || undefined;
      const mtimes = relFiles
        .map((rel) => state.sources[harness]?.[`skills/${dir.name}/${rel}`]?.mtimeMs)
        .filter((v): v is number => typeof v === 'number');
      const updatedAt = new Date(mtimes.length ? Math.max(...mtimes) : now()).toISOString();

      const entry: SkillEntry = {
        name,
        hash,
        ...(version ? { version } : {}),
        source,
        ...(origin ? { origin } : {}),
        updatedAt,
        files: files.map((f) => ({ rel: f.rel, size: f.bytes.length })),
      };

      const safe = safeSessionName(name);
      const versionDir = join(librarySkillsDir(vaultRoot), safe, 'versions', hash);
      try {
        await stat(versionDir);
      } catch {
        for (const f of files) {
          const target = join(versionDir, ...f.rel.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.bytes);
        }
        written++;
      }

      const versions = byName.get(name) ?? new Map<string, SkillEntry>();
      versions.set(hash, entry);
      byName.set(name, versions);
    }
  }

  const entries: Record<string, SkillEntry> = {};
  for (const [name, versions] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...versions.values()];
    const latest = pickLatestHash(list);
    entries[name] = versions.get(latest)!;
    const meta = {
      name,
      device: deviceId,
      versions: list.sort((a, b) => a.hash.localeCompare(b.hash)),
    };
    await writeAtomic(
      join(librarySkillsDir(vaultRoot), safeSessionName(name), 'meta', `${deviceId}.json`),
      JSON.stringify(meta, null, 2) + '\n',
    );
  }

  return { entries, versions: Object.keys(entries).length, written };
}

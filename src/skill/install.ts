/** 安装/卸载 trove skill 到 ~/.claude/skills 与 ~/.agents/skills。 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillTarget = 'claude' | 'agents' | 'both';

export interface SkillInstallResult {
  installed: string[];
  skipped: string[];
}

export interface SkillInstallOptions {
  target?: SkillTarget;
  force?: boolean;
  version: string;
}

const MARKER = '.trove-skill.json';

/** 源目录固定为包根的 skills/trove（dev 的 src/skill 与 dist/skill 都上两级）。 */
export function skillSourceDir(): string {
  return fileURLToPath(new URL('../../skills/trove', import.meta.url));
}

export function skillTargets(target: SkillTarget = 'both'): string[] {
  const claude = join(homedir(), '.claude', 'skills', 'trove');
  const agents = join(homedir(), '.agents', 'skills', 'trove');
  if (target === 'claude') return [claude];
  if (target === 'agents') return [agents];
  return [claude, agents];
}

async function sourceHash(source: string): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of ['SKILL.md', 'references/cli.md', 'references/mcp.md', 'references/examples.md']) {
    try {
      hash.update(rel);
      hash.update(await readFile(join(source, rel)));
    } catch {
      // 缺文件不阻断安装
    }
  }
  return hash.digest('hex');
}

async function markerOf(dest: string): Promise<{ hash?: string; version?: string } | null> {
  try {
    return JSON.parse(await readFile(join(dest, MARKER), 'utf8')) as { hash?: string; version?: string };
  } catch {
    return null;
  }
}

export async function installSkill(opts: SkillInstallOptions): Promise<SkillInstallResult> {
  const source = skillSourceDir();
  if (!existsSync(source)) throw new Error(`找不到 skill 源目录: ${source}`);
  const hash = await sourceHash(source);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const dest of skillTargets(opts.target)) {
    await mkdir(dirname(dest), { recursive: true });
    if (existsSync(dest) && !opts.force) {
      const marker = await markerOf(dest);
      if (!marker || marker.hash !== hash) {
        skipped.push(`${dest}（目标已存在且非未修改的 trove 安装；用 --force 覆盖）`);
        continue;
      }
      await rm(dest, { recursive: true, force: true });
    } else if (existsSync(dest) && opts.force) {
      await rm(dest, { recursive: true, force: true });
    }
    await cp(source, dest, { recursive: true });
    await writeFile(
      join(dest, MARKER),
      JSON.stringify({ version: opts.version, hash, installedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    installed.push(dest);
  }
  return { installed, skipped };
}

export async function uninstallSkill(opts: { target?: SkillTarget; force?: boolean } = {}): Promise<SkillInstallResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const dest of skillTargets(opts.target)) {
    if (!existsSync(dest)) continue;
    const marker = await markerOf(dest);
    if (!marker && !opts.force) {
      skipped.push(`${dest}（没有 trove 安装标记；用 --force 删除）`);
      continue;
    }
    await rm(dest, { recursive: true, force: true });
    installed.push(dest);
  }
  return { installed, skipped };
}

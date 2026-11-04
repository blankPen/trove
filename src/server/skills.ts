import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { librarySkillsDir, safeSessionName } from '../core/layout.js';
import { loadLibraryIndex } from '../core/library/index-file.js';

export interface SkillVersionItem {
  hash: string;
  source: string;
  updatedAt?: string;
  files: Array<{ rel: string; size: number }>;
  devices: string[];
}

export interface SkillItem {
  name: string;
  latest: string;
  version?: string;
  source: string;
  updatedAt?: string;
  devices: string[];
  versions: SkillVersionItem[];
}

/**
 * 技能清单:多版本谱系。
 *
 * 索引的键是技能真名,磁盘目录名是 safeSessionName(真名) ——
 * 两者只在名字含非法字符时才不同,取文件必须走 safeSessionName。
 */
export async function listSkills(vaultRoot: string): Promise<SkillItem[]> {
  const index = await loadLibraryIndex(vaultRoot);
  if (!index) return [];
  return Object.values(index.skills)
    .map((s) => {
      const latest = s.versions.find((v) => v.hash === s.latest) ?? s.versions[0];
      return {
        name: s.name,
        latest: s.latest,
        ...(latest?.version ? { version: latest.version } : {}),
        source: latest?.source ?? 'unknown',
        ...(latest?.updatedAt ? { updatedAt: latest.updatedAt } : {}),
        devices: [...new Set(s.versions.flatMap((v) => v.devices))].sort(),
        versions: s.versions
          .map((v) => ({
            hash: v.hash,
            source: v.source,
            ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
            files: v.files,
            devices: v.devices,
          }))
          .sort((a, b) => a.hash.localeCompare(b.hash)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 读技能版本里的一个文件。
 * rel 必须在该版本 meta 声明的文件清单内 —— 只拼路径是不够的,
 * 清单外的 rel 一律拒绝。
 */
export async function readSkillFile(
  vaultRoot: string,
  name: string,
  hash: string,
  rel: string,
): Promise<{ path: string; content: string } | null> {
  const index = await loadLibraryIndex(vaultRoot);
  const skill = index?.skills[name];
  if (!skill) return null;
  const version = skill.versions.find((v) => v.hash === hash);
  if (!version) return null;
  if (!version.files.some((f) => f.rel === rel)) return null;

  const root = librarySkillsDir(vaultRoot);
  const abs = join(root, safeSessionName(name), 'versions', hash, ...rel.split('/'));
  if (!abs.startsWith(root + sep)) return null;
  try {
    const content = await readFile(abs, 'utf8');
    return { path: rel, content };
  } catch {
    return null;
  }
}

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { minimatch } from 'minimatch';

/** 一个文件源(某个 agent 的原始落盘目录)。 */
export interface FileSourceConfig {
  id: string;
  displayName: string;
  root: string;
  /** 白名单 glob,相对 root;命中才归档(设计原则 2) */
  patterns: string[];
  /** 硬排除 glob,相对 root;优先于白名单 */
  exclusions: string[];
  /** 整棵跳过的目录 glob(性能剪枝,如 plugins、plugins/**) */
  pruneDirs?: string[];
  /** 会话 id 推导;默认一个文件就是一个会话 */
  sessionKeyOf?: (relPath: string) => string;
  /** 哪些文件算"会话"(用于计数);默认等于 patterns */
  sessionPatterns?: string[];
}

export interface DiscoveredFile {
  /** root 内相对路径,统一 '/' */
  relPath: string;
  absPath: string;
  sessionKey: string;
  size: number;
  mtimeMs: number;
  /** 所属会话的最近变更时间(同会话多文件取最大) */
  sessionMtimeMs: number;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => minimatch(path, g, { dot: true }));
}

function isPruned(relDir: string, pruneDirs: readonly string[]): boolean {
  if (!relDir) return false;
  return pruneDirs.some(
    (p) => minimatch(relDir, p, { dot: true }) || minimatch(relDir, `${p}/**`, { dot: true }),
  );
}

/** 递归收集目录下所有常规文件与"指向文件"的符号链接;不读内容。 */
async function walk(
  root: string,
  pruneDirs: readonly string[],
): Promise<Array<{ relPath: string; absPath: string }>> {
  const out: Array<{ relPath: string; absPath: string }> = [];
  const stack: string[] = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      const relPath = toPosix(relDir ? `${relDir}/${e.name}` : e.name);
      const absPath = join(absDir, e.name);
      if (e.isDirectory()) {
        if (!isPruned(relPath, pruneDirs)) stack.push(relPath);
        continue;
      }
      if (e.isSymbolicLink()) {
        try {
          const st = await stat(absPath);
          if (!st.isFile()) continue;
        } catch {
          continue; // 悬空链接
        }
      } else if (!e.isFile()) {
        continue;
      }
      out.push({ relPath, absPath });
    }
  }
  return out;
}

/**
 * 发现一个源里应归档的文件。只要目录遍历 + 路径匹配,不读文件内容,
 * 源文件零改写。白名单 ∩ 排除,排除优先。
 */
export async function discoverFiles(config: FileSourceConfig): Promise<DiscoveredFile[]> {
  const pruneDirs = config.pruneDirs ?? [];
  const found = await walk(config.root, pruneDirs);

  const out: DiscoveredFile[] = [];
  for (const f of found) {
    if (matchesAny(f.relPath, config.exclusions)) continue;
    if (!matchesAny(f.relPath, config.patterns)) continue;
    let st;
    try {
      st = await stat(f.absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const sessionKey = config.sessionKeyOf ? config.sessionKeyOf(f.relPath) : f.relPath;
    out.push({
      ...f,
      sessionKey,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      sessionMtimeMs: Math.round(st.mtimeMs),
    });
  }

  // 同一会话多文件:会话时间取最大,供 --since 判定(目录里旧附件不因自身 mtime 被漏掉)
  const sessionMax = new Map<string, number>();
  for (const f of out) {
    sessionMax.set(f.sessionKey, Math.max(sessionMax.get(f.sessionKey) ?? 0, f.mtimeMs));
  }
  for (const f of out) f.sessionMtimeMs = sessionMax.get(f.sessionKey)!;
  return out;
}

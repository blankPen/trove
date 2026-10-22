import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { minimatch } from 'minimatch';
import type { Source, SourceFile } from './types.js';

/** 把可能含 OS 分隔符的相对路径统一成 '/'。 */
function toPosix(rel: string): string {
  return rel.split(/[\\/]/).join('/');
}

/** 该相对路径是否命中白名单且未被排除(排除优先)。 */
function isIncluded(source: Source, relPath: string): boolean {
  if (source.exclusions.some((p) => minimatch(relPath, p))) return false;
  return source.patterns.some((p) => minimatch(relPath, p));
}

/**
 * 扫描一个 Source 的根目录,返回白名单 ∩ 排除后应归档的文件清单。
 * 不读文件内容,只做目录遍历 + 路径匹配;源文件零改写(设计原则 1)。
 */
export async function scanSource(source: Source): Promise<SourceFile[]> {
  const entries = await readdir(source.root, {
    recursive: true,
    withFileTypes: true,
  });

  const out: SourceFile[] = [];
  for (const e of entries) {
    if (e.isDirectory()) continue;

    // 常规文件直接收;符号链接解析后若指向文件也收(保真)。
    let isFile = e.isFile();
    if (!isFile && e.isSymbolicLink()) {
      try {
        const st = await stat(join(e.parentPath, e.name));
        isFile = st.isFile();
      } catch {
        isFile = false; // 悬空链接,跳过
      }
    }
    if (!isFile) continue;

    // 递归 readdir 的 e.name 只是 basename,完整相对路径需由 absPath 反推。
    const absPath = join(e.parentPath, e.name);
    const relPath = toPosix(relative(source.root, absPath));
    if (!isIncluded(source, relPath)) continue;

    out.push({ absPath, vaultPath: source.mapToVaultPath(absPath) });
  }
  return out;
}

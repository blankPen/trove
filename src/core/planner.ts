import type { Fingerprint, Manifest, PlanItem } from './types.js';

/** 扫描到的一个 vault 文件(路径 + 当前指纹)。 */
export interface ScannedFile {
  path: string;
  fingerprint: Fingerprint;
}

/**
 * 判定两个指纹是否代表"同一份内容"。只比 size + headHash,
 * 故意忽略 mtime —— mtime 不可跨设备比较,仅用于本地缓存(设计 §7.1)。
 */
export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.headHash === b.headHash;
}

/**
 * planner:从扫描结果 + manifest 生成操作计划。
 *
 * 纯函数 —— 无 IO、无时钟、无随机数(设计原则 6)。
 * 阶段 1 只输出 skip / full(设计 §14,offset 续传推迟到阶段 2):
 *   - manifest 无此路径        → full(新文件)
 *   - size + headHash 一致     → skip
 *   - 其余(增长/缩减/改写)     → full
 *
 * manifest 里有、扫描列表里没有的文件不产生任何操作 —— 只增不删(设计原则 3)。
 */
export function plan(
  scanned: readonly ScannedFile[],
  manifest: Manifest,
): PlanItem[] {
  const out: PlanItem[] = [];
  for (const file of scanned) {
    const entry = manifest[file.path];
    if (entry && fingerprintsEqual(file.fingerprint, entry.fingerprint)) {
      out.push({ path: file.path, action: 'skip', reason: 'unchanged' });
    } else {
      out.push({
        path: file.path,
        action: 'full',
        reason: entry ? 'changed' : 'new',
      });
    }
  }
  return out;
}

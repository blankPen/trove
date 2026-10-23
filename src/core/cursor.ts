/**
 * 游标变更判定(Beacon poll 骨架的核心语义,见 docs 调研 §游标三档)。
 *
 * 纯函数:只比较传入的元数据,不做 IO、不读时钟。
 * 与 Beacon 的差异:trove 归档 raw 字节,故用「本地归档前缀哈希」替代行号,
 * 从而在 append 前就能发现"文件被改写但 size 未回退"的情况。
 */

export interface FileCursor {
  /** 已归档的字节数 */
  size: number;
  /** 上次看到的源文件 mtime(ms) */
  mtimeMs: number;
  /** 已归档字节的 sha256(十六进制);本地归档被删/损坏时无法匹配 */
  prefixHash: string;
  /** 归档世代:改写/重建时换新,远端旧世代保留(永不删除) */
  generation: string;
}

export type FileAction = 'new' | 'skip' | 'append' | 'reset';

/**
 * 决定本轮对某源文件做什么:
 *   - size + mtime 均未变   → skip(不读内容)
 *   - 无游标              → new(全量归档)
 *   - size 回退           → reset(截断/重建)
 *   - size 相同但 mtime 变 → reset(就地改写,append 会把新旧内容混在一起)
 *   - size 增长且前缀哈希一致 → append(只搬新增字节)
 *   - 前缀哈希不一致       → reset(本地归档缺失或被改写)
 */
export function decideFileAction(
  cursor: FileCursor | undefined,
  src: { size: number; mtimeMs: number },
  archivedPrefixHash: string | null,
): FileAction {
  if (!cursor) return 'new';
  // 本地归档缺失:即使源文件没变也必须重建(vault 被清理/损坏后的自愈)
  if (archivedPrefixHash === null) return 'reset';
  if (src.size === cursor.size && src.mtimeMs === cursor.mtimeMs) return 'skip';
  if (src.size < cursor.size) return 'reset';
  if (src.size === cursor.size) return 'reset';
  return archivedPrefixHash === cursor.prefixHash ? 'append' : 'reset';
}

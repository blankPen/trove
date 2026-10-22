/** 字节数 → 人类可读字符串(如 "45 KB"、"1.2 MB"、"106 MB")。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let u = -1;
  while (value >= 1024 && u < units.length - 1) {
    value /= 1024;
    u++;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[u]}`;
}

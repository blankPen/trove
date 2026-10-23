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

/** 时间跨度 → "42 秒 / 5 分钟 / 2 小时 / 3 天";调用方自行加「前 / 后」。 */
export function humanSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时`;
  return `${Math.round(s / 86400)} 天`;
}

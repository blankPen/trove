/**
 * 同步时间窗:只收集「最近变更」的会话,避免首次全量过大。
 * 单位支持 m/h/d/w;all 表示不限制;也接受 YYYY-MM-DD(本地零点)。
 */

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** 返回截止时间(ms);0 表示不限制。非法输入抛错。 */
export function parseSince(input: string, now: number = Date.now()): number {
  const raw = input.trim().toLowerCase();
  if (raw === 'all' || raw === '' || raw === '0') return 0;

  const rel = /^(\d+)([mhdw])$/.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    return now - n * UNIT_MS[rel[2]!]!;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = new Date(`${raw}T00:00:00`).getTime();
    if (Number.isFinite(t)) return t;
  }

  throw new Error(`无法解析时间范围 "${input}"(示例:7d / 24h / 2026-10-01 / all)`);
}

/** 展示用:0 显示 all,其它显示本地日期时间。 */
export function formatSince(cutoff: number): string {
  if (!cutoff) return 'all';
  const d = new Date(cutoff);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

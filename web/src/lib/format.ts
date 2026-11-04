/** 数字与时间的呈现口径:牌面要求数字一律等宽、带分隔符、符号表意。 */

const INT = new Intl.NumberFormat('zh-CN');

export function n(value: number): string {
  return INT.format(value);
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function tokens(value: number): string {
  if (value < 1000) return n(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

const DATE = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DAY = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });

export function dateTime(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return DATE.format(new Date(t)).replace(/\//g, '-');
}

export function day(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return DAY.format(new Date(t)).replace(/\//g, '-');
}

/** 距今多久。用于「上次同步 3 分钟前」。 */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const d = Math.max(0, now - ms);
  if (d < 1000) return '刚刚';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/** harness 的中文名。界面用词,不给原始 id。 */
export const HARNESS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  doubao: '豆包',
};

export function harnessName(id: string): string {
  return HARNESS[id] ?? id;
}

/** 事件类型的中文名 + 语义类。 */
export function eventKind(kind: string, role?: string): { label: string; cls: string } {
  switch (kind) {
    case 'session':
      return { label: '会话头', cls: 'kind-meta' };
    case 'message':
      if (role === 'user') return { label: '用户', cls: 'kind-user' };
      if (role === 'assistant') return { label: '助手', cls: 'kind-assistant' };
      return { label: '消息', cls: 'kind-assistant' };
    case 'reasoning':
      return { label: '推理', cls: 'kind-meta' };
    case 'tool_call':
      return { label: '工具调用', cls: 'kind-tool' };
    case 'tool_result':
      return { label: '工具结果', cls: 'kind-tool' };
    case 'meta':
      return { label: '元信息', cls: 'kind-meta' };
    default:
      return { label: kind, cls: 'kind-meta' };
  }
}

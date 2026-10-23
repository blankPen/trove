import type { HarnessId } from '../../adapters/index.js';

/** 对话层文件在 harness 目录下的前缀。 */
export const EVENTS_PREFIX = '_events/';

/** 对话层格式版本:映射逻辑变化时递增,collect 会据此重生成(旧事件文件自动换个世代)。 */
export const EVENTS_FORMAT_VERSION = 4;

export type EventKind = 'session' | 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'meta';
export type EventRole = 'user' | 'assistant' | 'system' | 'tool';

export interface EventPart {
  type: string;
  text?: string;
  mime?: string;
  name?: string;
}

/** 一个待映射的原始文件。 */
export interface MapperFile {
  /** 相对 harness 目录的路径,如 `projects/x.jsonl` */
  relPath: string;
  /** 完整 raw 路径(相对 vault),如 `raw/dev1/claude-code/projects/x.jsonl` */
  rawPath: string;
  text: string;
  /** 文件级线程归属(Claude 子代理文件) */
  thread?: string;
}

export interface EventUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
}

/**
 * 一条对话层事件。`raw` 回指 vault 内的原始文件与行号,
 * 事件里没映射到的内容(注入上下文、图片二进制、旧序列化字段)都能凭它反查。
 */
export interface Event {
  v: 1;  /** ISO-8601 UTC 毫秒;源里没有则为空串 */
  ts: string;
  /** 会话内递增序号,从 0 开始(0 固定是 session 头) */
  seq: number;
  harness: HarnessId;
  session: string;
  kind: EventKind;
  role?: EventRole;
  id?: string;
  text?: string;
  parts?: EventPart[];
  tool?: { name?: string; call_id?: string; input?: unknown };
  result?: { call_id?: string; status?: 'ok' | 'error'; output?: unknown };
  usage?: EventUsage;
  model?: { provider?: string; id?: string };
  cwd?: string;
  /** 子代理 / sidechain / 豆包 agent */
  thread?: string;
  /** raw 路径相对 vault/devices/<device>/,如 claude-code/projects/x.jsonl */
  raw?: { path: string; line: number };
  /** 未映射的原生字段,保留但不保证语义 */
  extra?: Record<string, unknown>;
  // ── 仅 session 头 ──
  title?: string;
  /** 该会话的 raw 来源(完整路径),仅 session 头 */
  sources?: string[];
  firstText?: string;
  startedAt?: string;
}

/** 数字时间戳(ms)或字符串 → ISO-8601 UTC;无法解析返回空串。 */
export function isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return '';
}

/** 去掉 undefined/空串字段,避免事件里出现大量 null。 */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '' || v === null) continue;
    out[k] = v;
  }
  return out as T;
}

/** 把一段文本截成列表页要的一行摘要。 */
export function firstLine(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

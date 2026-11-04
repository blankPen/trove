/** 后端接口的唯一入口。类型与 src/server 的响应一一对应。 */

export interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  startedAt: number;
  intervalSeconds: number;
  since: string;
  lastRunAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  nextRunAt?: number;
  lastResult?: {
    collected: { archived: number; appended: number; sessions: number; bytesCopied: number };
    pulled: { downloadedItems: number; downloadedBytes: number };
    pushed: { uploadedItems: number; uploadedBytes: number };
  };
}

export interface Overview {
  device: { id: string; name: string };
  remote: { type: string; desc: string };
  daemon: { running: boolean; pid: number | null; status: DaemonStatus | null };
  counts: {
    sessions: number;
    events: number;
    skills: number;
    lessons: number;
    lessonsByCategory: Record<string, number>;
    /** 最近 30 天的逐日会话数,没有会话的日子是 0。 */
    perDay: Array<{ date: string; count: number }>;
  };
  pending: {
    raw: { sessions: number; files: number; bytes: number };
    library: {
      sessions: { count: number; files: number; bytes: number };
      skills: { files: number; bytes: number };
      index: { files: number; bytes: number };
    };
  };
  usage: {
    total: UsageBucket;
    byTask: Record<string, UsageBucket>;
    byModel: Record<string, UsageBucket>;
  };
  generatedAt: string;
}

export interface SessionItem {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  bytes: number;
  events: number;
  devices: string[];
  variants: number;
}

export interface SessionList {
  total: number;
  items: SessionItem[];
}

export interface SessionDetail {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  sources: string[];
  canonical: { device: string; path: string; hash: string; events: number };
  variants: Array<{ device: string; path: string; hash: string; events: number }>;
  eventTotal: number;
  path: string;
}

export interface EventPage {
  offset: number;
  limit: number;
  eventTotal: number;
  events: Array<{
    v: number;
    seq: number;
    kind: string;
    role?: string;
    text?: string;
    tool?: { name?: string; call_id?: string; input?: unknown };
    result?: { call_id?: string; status?: string; output?: unknown };
    model?: { id?: string };
    ts?: string;
    __truncated?: Record<string, number>;
  }>;
}

export interface LessonItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  scope: string;
  source: string | null;
  createdAt?: string;
  updatedAt?: string;
  preview: string;
}

export interface LessonCategory {
  category: string;
  label: string;
  count: number;
  items: LessonItem[];
}

export interface SkillVersion {
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
  versions: SkillVersion[];
}

export interface Usage {
  total: UsageBucket;
  byTask: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  hasLedger: boolean;
  /** LLM 端点是否配好 —— 决定台账为什么是空的。 */
  llmConfigured: boolean;
  /** 三个字段各自配没配(只给布尔,apiKey 的值不出进程)。 */
  llmFields: { baseUrl: boolean; model: boolean; apiKey: boolean };
  /** 队列里还没提取经验的会话 —— 每提取一次就是一次 LLM 调用。 */
  pendingExtraction: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail?.error ?? `请求失败(${res.status})`);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail?.error ?? `请求失败(${res.status})`);
  }
  return (await res.json()) as T;
}

export const api = {
  overview: () => get<Overview>('/api/overview'),
  sessions: (q: { harness?: string; device?: string; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (q.harness) p.set('harness', q.harness);
    if (q.device) p.set('device', q.device);
    if (q.q) p.set('q', q.q);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    if (q.offset !== undefined) p.set('offset', String(q.offset));
    const s = p.toString();
    return get<SessionList>(`/api/sessions${s ? `?${s}` : ''}`);
  },
  session: (key: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(key)}`),
  sessionEvents: (key: string, offset: number, limit: number) =>
    get<EventPage>(`/api/sessions/${encodeURIComponent(key)}/events?offset=${offset}&limit=${limit}`),
  lessons: () => get<LessonCategory[]>('/api/lessons'),
  lessonFile: (path: string) =>
    get<{ path: string; content: string }>(`/api/lessons/file?path=${encodeURIComponent(path)}`),
  skills: () => get<SkillItem[]>('/api/skills'),
  skillFile: (name: string, hash: string, rel: string) =>
    get<{ path: string; content: string }>(
      `/api/skills/file?name=${encodeURIComponent(name)}&hash=${encodeURIComponent(hash)}&rel=${encodeURIComponent(rel)}`,
    ),
  usage: () => get<Usage>('/api/usage'),
  daemon: () => get<{ running: boolean; pid?: number; status: DaemonStatus | null }>('/api/daemon'),
  restartDaemon: () => post<{ pid: number; wasRunning: boolean }>('/api/daemon/restart'),
  startSync: () => post<{ jobId: string }>('/api/sync'),
};

/** 同步进度的 SSE 通道。 */
export function syncStream(
  jobId: string,
  onEvent: (type: string, data: Record<string, unknown>) => void,
): () => void {
  const es = new EventSource(`/api/sync/${jobId}/events`);
  for (const type of ['phase', 'item', 'locked', 'done', 'error']) {
    es.addEventListener(type, (e) => {
      try {
        onEvent(type, JSON.parse((e as MessageEvent).data));
      } catch {
        onEvent(type, {});
      }
    });
  }
  return () => es.close();
}

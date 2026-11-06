import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_CAPACITY, type CapacityConfig } from './core/lessons/capacity.js';

/** 配置数据模型(设计 §10.2)。 */

export interface DeviceConfig {
  id: string;
  name: string;
}

export interface WebDavRemoteConfig {
  type: 'webdav';
  url: string;
  username: string;
  /** 明文存储,仅存于 config.json(权限 600),跨平台不依赖系统钥匙串。 */
  password: string;
}

export interface S3RemoteConfig {
  type: 's3';
  /** 厂商预设(aliyun / tencent);手填 endpoint 时可省略。 */
  provider?: 'aliyun' | 'tencent';
  region: string;
  bucket: string;
  /** 手填 endpoint 覆盖厂商推导。 */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** path-style 寻址;阿里云 OSS 默认 false(走 path-style 会 403)。 */
  forcePathStyle?: boolean;
}

/** 远端配置:按 type 区分后端。 */
export type RemoteConfig = WebDavRemoteConfig | S3RemoteConfig;

export type SourceId = 'claude-code' | 'codex' | 'opencode' | 'doubao';

export type SourcesConfig = Partial<Record<SourceId, { enabled: boolean }>>;

export interface SyncConfig {
  /** 是否同步 raw;关闭后只同步 library */
  raw: boolean;
}

export interface DaemonConfig {
  /** 轮询间隔秒数,使用处下限 5 */
  intervalSeconds: number;
  /** 只收集最近变更的会话:7d / 24h / 2026-10-01 / all */
  since: string;
  /** init 后自动启动 daemon */
  startOnInit: boolean;
  /** learn 独立循环间隔秒数(与 sync 解耦) */
  learnIntervalSeconds: number;
  /** learn 每个 tick 最多处理的候选会话数 */
  learnBatch: number;
}

/** v2 学习质量门限(0..1)。 */
export interface LearnQualityConfig {
  /** 总质量分 ≥ 该值且五维达标 → 自动接受 */
  autoAccept: number;
  /** 总质量分 ≥ 该值 → 升级人工/LLM 裁决 */
  reviewFloor: number;
  /** 证据分硬门:低于该值直接拒绝 */
  evidenceMin: number;
}

/** 记忆生命周期参数(curator 用)。 */
export interface LearnLifecycleConfig {
  /** 多少天没被用到算 stale */
  staleDays: number;
  /** 多少天没被用到算归档 */
  archiveDays: number;
  /** 轨迹保留天数 */
  trajectoryDays: number;
  /** 单项目最多保留多少条轨迹 */
  trajectoryMax: number;
}

/** 本地检索后端配置：qmd 混合检索（BM25 + 向量 + 查询扩展 + 重排）。 */
export interface LearnSearchConfig {
  enabled: boolean;
  /** 嵌入模型 URI（hf:<repo>/<file>）。 */
  model: string;
  /** 模型下载镜像（HF_ENDPOINT）；可用 learn.search.host 覆盖。 */
  host: string;
  /** 最低命中分；低于此分不返回（0 = 不过滤）。 */
  minScore: number;
}

export interface LearnConfig {
  /** off=关闭;shadow=只计算并写审计;review=经验进 inbox 人工审;auto=达阈值直接写 */
  mode: 'off' | 'shadow' | 'review' | 'auto';
  /** 正式学习前自动把老 v1 记忆迁移为 v2 schema;默认开启 */
  autoMigrate: boolean;
  /** 暂停队列消费(daemon 不跑学习作业) */
  paused: boolean;
  /** 每日 token 预算上限;达到即暂停当日学习 */
  dailyTokenBudget: number;
  /** 单个作业最大尝试次数 */
  maxAttempts: number;
  /** 作业租约时长(毫秒),超时未心跳视为崩溃可重领 */
  leaseTtlMs: number;
  quality: LearnQualityConfig;
  jev: { maxCallsPerSession: number; timeoutMs: number };
  lifecycle: LearnLifecycleConfig;
  capacity: CapacityConfig;
  search: LearnSearchConfig;
}

/** learn 默认值,`defaultConfig` 与 `readLearnConfig` 共用,避免重复字面量。 */
export function defaultLearnConfig(): LearnConfig {
  return {
    mode: 'review',
    autoMigrate: true,
    paused: false,
    dailyTokenBudget: 200000,
    maxAttempts: 5,
    leaseTtlMs: 300000,
    quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 },
    jev: { maxCallsPerSession: 8, timeoutMs: 2000 },
    lifecycle: { staleDays: 14, archiveDays: 30, trajectoryDays: 90, trajectoryMax: 500 },
    capacity: { ...DEFAULT_CAPACITY },
    search: {
      enabled: true,
      model: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
      host: 'https://hf-mirror.com',
      minScore: 0,
    },
  };
}

const LEARN_MODES: ReadonlyArray<LearnConfig['mode']> = ['off', 'shadow', 'review', 'auto'];

/** 白名单兜底 review:非法/未知 mode 一律回退 review,不静默改成会直接写盘的 auto。 */
export function normalizeLearnMode(v: unknown): LearnConfig['mode'] {
  return (LEARN_MODES as readonly unknown[]).includes(v) ? (v as LearnConfig['mode']) : 'review';
}

export interface Config {
  device: DeviceConfig;
  remote: RemoteConfig;
  sources: SourcesConfig;
  sync: SyncConfig;
  daemon: DaemonConfig;
  /** 经验提取 LLM 端点;缺省视为未配置,手动 learn 时报错提示 trove config set */
  llm?: { baseUrl: string; model: string; apiKey: string };
  /** Jev 打分端点;baseUrl 缺省用官方端点,可指向代理/镜像绕过区域限制 */
  jev?: { apiKey: string; model: string; baseUrl?: string };
  /** v2 学习流水线配置;老配置缺字段时深合并补默认 */
  learn: LearnConfig;
}

/** 命令行显式开关优先;否则取配置;老配置文件缺省按开启。 */
export function resolveRawSync(config: Pick<Config, 'sync'>, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return config.sync?.raw !== false;
}

export function defaultConfig(
  opts: { deviceId?: string; deviceName?: string } = {},
): Config {
  return {
    device: {
      id: opts.deviceId ?? randomUUID(),
      name: opts.deviceName ?? hostname(),
    },
    remote: {
      type: 'webdav',
      url: '',
      username: 'webdav',
      password: '',
    },
    // 四个工具均已实现,默认全开;config.sources[id].enabled=false 可单独关闭。
    sources: {
      'claude-code': { enabled: true },
      codex: { enabled: true },
      opencode: { enabled: true },
      doubao: { enabled: true },
    },
    sync: { raw: true },
    daemon: { intervalSeconds: 300, since: '7d', startOnInit: true, learnIntervalSeconds: 60, learnBatch: 3 },
    learn: defaultLearnConfig(),
  };
}

/** 读取配置;文件不存在时返回默认配置。损坏的 JSON 抛含路径的错误。 */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new Error(`配置文件损坏,无法解析 JSON: ${path}`);
  }
  // 老配置没有 sync / daemon / learn 字段:按默认补齐
  return {
    ...parsed,
    remote: normalizeRemote(parsed.remote),
    sync: { raw: parsed.sync?.raw !== false },
    daemon: {
      intervalSeconds: parsed.daemon?.intervalSeconds ?? 300,
      since: parsed.daemon?.since ?? '7d',
      startOnInit: parsed.daemon?.startOnInit !== false,
      learnIntervalSeconds: parsed.daemon?.learnIntervalSeconds ?? 60,
      learnBatch: parsed.daemon?.learnBatch ?? 3,
    },
    learn: normalizeLearn(parsed.learn),
  };
}

/** 老配置的 learn 段深合并:缺字段补默认、部分覆盖不丢、数值保持原样(钳制交给 readLearnConfig)。 */
export function normalizeLearn(learn: unknown): LearnConfig {
  const d = defaultLearnConfig();
  const l = (learn ?? {}) as Record<string, unknown>;
  const q = (l.quality ?? {}) as Record<string, unknown>;
  const j = (l.jev ?? {}) as Record<string, unknown>;
  const c = (l.lifecycle ?? {}) as Record<string, unknown>;
  const cap = (l.capacity ?? {}) as Record<string, unknown>;
  const s = (l.search ?? {}) as Record<string, unknown>;
  return {
    mode: normalizeLearnMode(l.mode),
    autoMigrate: l.autoMigrate !== false,
    paused: l.paused === true,
    dailyTokenBudget: num(l.dailyTokenBudget, d.dailyTokenBudget),
    maxAttempts: num(l.maxAttempts, d.maxAttempts),
    leaseTtlMs: num(l.leaseTtlMs, d.leaseTtlMs),
    quality: {
      autoAccept: num(q.autoAccept, d.quality.autoAccept),
      reviewFloor: num(q.reviewFloor, d.quality.reviewFloor),
      evidenceMin: num(q.evidenceMin, d.quality.evidenceMin),
    },
    jev: {
      maxCallsPerSession: num(j.maxCallsPerSession, d.jev.maxCallsPerSession),
      timeoutMs: num(j.timeoutMs, d.jev.timeoutMs),
    },
    lifecycle: {
      staleDays: num(c.staleDays, d.lifecycle.staleDays),
      archiveDays: num(c.archiveDays, d.lifecycle.archiveDays),
      trajectoryDays: num(c.trajectoryDays, d.lifecycle.trajectoryDays),
      trajectoryMax: num(c.trajectoryMax, d.lifecycle.trajectoryMax),
    },
    capacity: {
      experiencesPerProject: num(cap.experiencesPerProject, d.capacity.experiencesPerProject),
      experiencesGlobal: num(cap.experiencesGlobal, d.capacity.experiencesGlobal),
      profileBytes: num(cap.profileBytes, d.capacity.profileBytes),
      entitiesPerType: num(cap.entitiesPerType, d.capacity.entitiesPerType),
    },
    search: {
      enabled: s.enabled !== false,
      model: strNonEmpty(s.model, d.search.model),
      host: strNonEmpty(s.host, d.search.host),
      minScore: Math.max(0, num(s.minScore, d.search.minScore)),
    },
  };
}

function strNonEmpty(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 老配置(只有 url/username/password,没有 type)按 webdav 处理;
 * 已经是 s3 的配置原样保留。
 */
export function normalizeRemote(remote: unknown): RemoteConfig {
  const r = (remote ?? {}) as Record<string, unknown>;
  if (r.type === 's3') {
    return {
      type: 's3',
      provider: r.provider as 'aliyun' | 'tencent' | undefined,
      region: (r.region as string) ?? '',
      bucket: (r.bucket as string) ?? '',
      endpoint: r.endpoint as string | undefined,
      accessKeyId: (r.accessKeyId as string) ?? '',
      secretAccessKey: (r.secretAccessKey as string) ?? '',
      forcePathStyle: r.forcePathStyle as boolean | undefined,
    };
  }
  return {
    type: 'webdav',
    url: (r.url as string) ?? '',
    username: (r.username as string) ?? 'webdav',
    password: (r.password as string) ?? '',
  };
}

/** 原子写入配置:先写临时文件再 rename,避免写一半损坏(设计原则 5)。含明文密码,权限收紧为 600。 */
export async function saveConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

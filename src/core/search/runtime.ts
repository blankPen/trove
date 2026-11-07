/**
 * 检索运行时：一个进程内唯一的检索执行者。
 * 负责串行闸门（Metal 上并发上下文会卡死）、模型保活、健康统计。
 * daemon 用它服务所有客户端；CLI 在 daemon 不可用时用它本地兜底。
 */
import type { QmdHit, QmdSyncResult } from './qmd.js';

export interface RuntimeSearchOptions {
  categories?: readonly string[];
  limit?: number;
}

/** 注入检索实现，测试用假实现；生产由 qmd 封装提供。 */
export interface SearchRuntimeDeps {
  search(query: string, opts: RuntimeSearchOptions): Promise<QmdHit[]>;
  warm?(): Promise<void>;
  touch?(): boolean;
  /** 增量重建索引（store.update + embed）。与检索共用串行闸门。 */
  reindex?(): Promise<QmdSyncResult>;
}

export interface SearchStats {
  warm: boolean;
  lastUsedAt: number | null;
  inflight: number;
  total: number;
  p50Ms: number | null;
}

export interface SearchRuntimeOptions {
  /** 最近一次检索后保持模型热的分钟数；0 = 不保活。 */
  keepWarmMinutes: number;
  /** 保活检查间隔。 */
  tickMs?: number;
}

export class SearchRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  private warm = false;
  private lastUsedAt = 0;
  private total = 0;
  private latencies: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: SearchRuntimeDeps,
    private readonly opts: SearchRuntimeOptions,
  ) {}

  /** 串行执行检索：同一时刻只有一个查询进入模型。 */
  async search(query: string, opts: RuntimeSearchOptions = {}): Promise<QmdHit[]> {
    const run = async (): Promise<QmdHit[]> => {
      this.inflight++;
      const started = performance.now();
      try {
        const hits = await this.deps.search(query, opts);
        this.warm = true;
        this.lastUsedAt = Date.now();
        this.total++;
        this.latencies.push(performance.now() - started);
        if (this.latencies.length > 200) this.latencies.shift();
        return hits;
      } finally {
        this.inflight--;
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** 启动期预热；与检索共用串行闸门，避免和首查争 GPU。 */
  async warmup(): Promise<boolean> {
    if (!this.deps.warm) return false;
    const run = async (): Promise<boolean> => {
      try {
        await this.deps.warm!();
        this.warm = true;
        this.lastUsedAt = Date.now();
        return true;
      } catch {
        return false;
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** 在保活窗口内周期性 touch，抵消 qmd 的 5 分钟空闲卸载。 */
  startKeepWarm(): void {
    if (this.timer || !this.deps.touch || this.opts.keepWarmMinutes <= 0) return;
    const windowMs = this.opts.keepWarmMinutes * 60_000;
    this.timer = setInterval(() => {
      if (!this.warm) return;
      if (Date.now() - this.lastUsedAt > windowMs) {
        this.warm = false;
        return;
      }
      this.deps.touch?.();
    }, this.opts.tickMs ?? 60_000);
    this.timer.unref();
  }

  /** 重建索引；与检索共用闸门，避免 embed 和查询同时抢 GPU。 */
  async reindex(): Promise<QmdSyncResult | null> {
    if (!this.deps.reindex) return null;
    const run = (): Promise<QmdSyncResult> => this.deps.reindex!();
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  stats(): SearchStats {
    const sorted = this.latencies.length ? [...this.latencies].sort((a, b) => a - b) : [];
    return {
      warm: this.warm,
      lastUsedAt: this.lastUsedAt || null,
      inflight: this.inflight,
      total: this.total,
      p50Ms: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]!) : null,
    };
  }
}
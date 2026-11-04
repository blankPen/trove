import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { Progress } from '../progress.js';

export type SyncEvent =
  | { type: 'phase'; name: string; detail?: string }
  | { type: 'item'; label: string; current: number; total: number; bytes?: number }
  | { type: 'locked'; pid: number }
  | { type: 'done'; report: unknown }
  | { type: 'error'; message: string };

/** 同步执行器:默认是 core 的 sync(),测试注入假实现。 */
export type SyncRunner = (progress: Progress) => Promise<unknown>;

export interface JobOptions {
  runner: SyncRunner;
  /** 锁文件路径;用于等 daemon 释放。 */
  lockPath: string;
  /** 撞锁后多久探一次锁。 */
  retryDelayMs: number;
  /** 撞锁后最多等多久。 */
  maxWaitMs: number;
}

/** acquireLock 抢不到时的原话。 */
const LOCK_RE = /已有同步在运行\s*\(pid\s*(\d+)\)/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次同步作业。事件先进队列,SSE 端点按序取走。
 * 队列留着是为了让 SSE 晚连上也不丢事件(前端先 POST 再连,可能差几十毫秒)。
 */
export class SyncJob {
  readonly id = randomUUID();
  private queue: SyncEvent[] = [];
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly opts: JobOptions) {}

  private push(e: SyncEvent): void {
    this.queue.push(e);
    for (const w of this.waiters.splice(0)) w();
  }

  /** 跑同步;撞锁则等锁释放后重试一次。 */
  async run(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const progress: Progress = {
        phase: (name, detail) => this.push({ type: 'phase', name, ...(detail ? { detail } : {}) }),
        item: (label, current, total, bytes) =>
          this.push({ type: 'item', label, current, total, ...(bytes !== undefined ? { bytes } : {}) }),
      };
      try {
        const report = await this.opts.runner(progress);
        this.push({ type: 'done', report });
        this.close();
        return;
      } catch (err) {
        const message = (err as Error).message;
        const m = LOCK_RE.exec(message);
        if (m && attempt === 0) {
          this.push({ type: 'locked', pid: Number(m[1]) });
          const freed = await this.waitLock();
          if (freed) continue;
          this.push({ type: 'error', message: '同步正在进行,请稍后重试' });
          this.close();
          return;
        }
        this.push({ type: 'error', message });
        this.close();
        return;
      }
    }
  }

  /** 等锁文件消失;等到返回 true,超时返回 false。 */
  private async waitLock(): Promise<boolean> {
    const deadline = Date.now() + this.opts.maxWaitMs;
    while (Date.now() < deadline) {
      if (!(await exists(this.opts.lockPath))) return true;
      await new Promise((r) => setTimeout(r, this.opts.retryDelayMs));
    }
    return !(await exists(this.opts.lockPath));
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 按序取事件;作业结束且队列空了才结束。 */
  async *read(): AsyncGenerator<SyncEvent> {
    for (;;) {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        yield e;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

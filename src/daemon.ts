import { spawn } from 'node:child_process';
import { open, readFile, rename, stat, unlink, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isProcessAlive } from './core/lock.js';
import { execFileSync } from 'node:child_process';
import type { Progress } from './progress.js';
import type { SyncReport } from './core/sync.js';
import type { TrovePaths } from './paths.js';

export interface DaemonStatusFile {
  running: boolean;
  pid: number;
  startedAt: number;
  intervalSeconds: number;
  since: string;
  lastRunAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  lastResult?: Pick<SyncReport, 'collected' | 'pulled' | 'pushed'>;
  nextRunAt?: number;
}

export interface DaemonRuntime {
  paths: TrovePaths;
  intervalSeconds: number;
  since: string;
  /** 一轮同步;由 CLI 注入(config/adapters/remote 的组装) */
  runOnce: (progress: Progress, signal: AbortSignal) => Promise<SyncReport>;
}

export const isAlive = isProcessAlive;

async function readPidFile(paths: TrovePaths): Promise<{ pid: number; startedAt: number } | null> {
  try {
    const raw = await readFile(paths.daemonPid, 'utf8');
    const v = JSON.parse(raw) as { pid?: number; startedAt?: number };
    if (typeof v.pid !== 'number') return null;
    return { pid: v.pid, startedAt: v.startedAt ?? 0 };
  } catch {
    return null;
  }
}

/** 单实例锁:pid 文件不存在才创建;陈旧 pid(进程已死)自动接管。 */
export async function acquireDaemonPid(paths: TrovePaths): Promise<void> {
  await mkdir(dirname(paths.daemonPid), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(paths.daemonPid, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await fh.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await readPidFile(paths);
      if (existing && isAlive(existing.pid)) {
        throw new Error(`daemon 已在运行 (pid ${existing.pid})`);
      }
      await unlink(paths.daemonPid).catch(() => {});
    }
  }
  throw new Error('无法获取 daemon 单实例锁');
}

export async function releaseDaemonPid(paths: TrovePaths): Promise<void> {
  const existing = await readPidFile(paths);
  if (!existing || existing.pid === process.pid) {
    await unlink(paths.daemonPid).catch(() => {});
  }
}

export async function readDaemonStatus(paths: TrovePaths): Promise<DaemonStatusFile | null> {
  try {
    return JSON.parse(await readFile(paths.daemonStatus, 'utf8')) as DaemonStatusFile;
  } catch {
    return null;
  }
}

async function writeDaemonStatus(paths: TrovePaths, status: DaemonStatusFile): Promise<void> {
  await mkdir(dirname(paths.daemonStatus), { recursive: true });
  const tmp = `${paths.daemonStatus}.tmp`;
  await writeFile(tmp, JSON.stringify(status, null, 2));
  await rename(tmp, paths.daemonStatus);
}

/** 日志超过 10MB 轮转一份,避免 daemon 无限写。 */
export async function daemonLog(paths: TrovePaths, text: string): Promise<void> {
  await mkdir(dirname(paths.daemonLog), { recursive: true });
  try {
    const st = await stat(paths.daemonLog);
    if (st.size > 10 * 1024 * 1024) {
      await rename(paths.daemonLog, `${paths.daemonLog}.1`).catch(() => {});
    }
  } catch {
    // 日志还不存在
  }
  await appendFile(paths.daemonLog, `${new Date().toISOString()} ${text}\n`);
}

function logProgress(paths: TrovePaths): Progress {
  let last = 0;
  return {
    phase(name, detail) {
      void daemonLog(paths, `[${name}]${detail ? ` ${detail}` : ''}`);
    },
    item(label, current, total) {
      const now = Date.now();
      if (now - last < 10_000 && current < total) return;
      last = now;
      void daemonLog(paths, `[progress] ${current}/${total} ${label}`);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * daemon 主循环:立即跑一轮,之后每 interval 秒一轮;SIGTERM/abort 后清理 pid 退出。
 * 每轮状态写 daemon.status.json,供 `trove daemon status` 读取。
 */
export async function runDaemon(runtime: DaemonRuntime, signal: AbortSignal): Promise<void> {
  const { paths, intervalSeconds, since, runOnce } = runtime;
  await acquireDaemonPid(paths);

  const status: DaemonStatusFile = {
    running: true,
    pid: process.pid,
    startedAt: Date.now(),
    intervalSeconds,
    since,
  };
  await writeDaemonStatus(paths, status);
  await daemonLog(paths, `daemon 启动 pid=${process.pid} interval=${intervalSeconds}s since=${since}`);

  try {
    while (!signal.aborted) {
      const started = Date.now();
      status.lastRunAt = started;
      await writeDaemonStatus(paths, status); // 让 status 命令能看到"正在跑"
      try {
        const report = await runOnce(logProgress(paths), signal);
        status.lastResult = {
          collected: report.collected,
          pulled: report.pulled,
          pushed: report.pushed,
        };
        status.lastError = undefined;
        await daemonLog(
          paths,
          `同步完成:收集 ${report.collected.archived}/${report.collected.appended} · ` +
            `拉取 ${report.pulled.downloadedItems} · 推送 ${report.pushed.uploadedItems} · ` +
            `库拉取 ${report.library?.pulled.downloaded ?? 0} · 库推送 ${report.library?.pushed.uploaded ?? 0} · ` +
            `${report.durationMs}ms`,
        );
      } catch (err) {
        if (signal.aborted) break; // 主动停止,不算同步失败
        status.lastError = (err as Error).message;
        await daemonLog(paths, `同步失败: ${status.lastError}`);
      }
      status.lastDurationMs = Date.now() - started;
      status.nextRunAt = Date.now() + intervalSeconds * 1000;
      await writeDaemonStatus(paths, status);
      await sleep(intervalSeconds * 1000, signal);
    }
  } finally {
    status.running = false;
    status.nextRunAt = undefined;
    await writeDaemonStatus(paths, status);
    await releaseDaemonPid(paths);
    await daemonLog(paths, 'daemon 退出');
  }
}

export interface StartDaemonOptions {
  paths: TrovePaths;
  intervalSeconds: number;
  since: string;
  /** 显式 raw 同步开关;undefined = 跟随配置 */
  raw?: boolean;
  /** 默认 process.argv[1](构建后的 dist/main.js) */
  entry?: string;
}

/** 后台启动:spawn 一个独立进程,等待 pid 文件落盘后返回。 */
export async function startDaemon(opts: StartDaemonOptions): Promise<number> {
  const existing = await readPidFile(opts.paths);
  if (existing && isAlive(existing.pid)) {
    throw new Error(`daemon 已在运行 (pid ${existing.pid})`);
  }
  await mkdir(dirname(opts.paths.daemonLog), { recursive: true });
  const fd = await open(opts.paths.daemonLog, 'a');
  const entry = opts.entry ?? process.argv[1]!;
  const child = spawn(
    process.execPath,
    [
      entry,
      'daemon',
      'run',
      '--interval',
      String(opts.intervalSeconds),
      '--since',
      opts.since,
      ...(opts.raw === true ? ['--raw'] : opts.raw === false ? ['--no-raw'] : []),
    ],
    { detached: true, stdio: ['ignore', fd.fd, fd.fd], env: process.env },
  );
  child.unref();
  await fd.close();

  for (let i = 0; i < 60; i++) {
    const pid = await readPidFile(opts.paths);
    if (pid && isAlive(pid.pid)) return pid.pid;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon 启动超时,请查看 ${opts.paths.daemonLog}`);
}

function processStartedAt(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** 优雅停止:发 SIGTERM,最多等 5 秒;不做 SIGKILL,避免中断写入。 */
export async function stopDaemon(paths: TrovePaths): Promise<boolean> {
  const existing = await readPidFile(paths);
  if (!existing || !isAlive(existing.pid)) {
    await releaseDaemonPid(paths);
    return false;
  }
  // pid 可能被系统复用:启动时间对不上就只清理陈旧锁,绝不误杀
  const actualStart = processStartedAt(existing.pid);
  if (existing.startedAt && actualStart && Math.abs(actualStart - existing.startedAt) > 5000) {
    await releaseDaemonPid(paths);
    return false;
  }
  process.kill(existing.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!isAlive(existing.pid)) {
      await releaseDaemonPid(paths);
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function daemonState(paths: TrovePaths): Promise<{
  running: boolean;
  pid?: number;
  status: DaemonStatusFile | null;
}> {
  const pid = await readPidFile(paths);
  return {
    running: Boolean(pid && isAlive(pid.pid)),
    ...(pid ? { pid: pid.pid } : {}),
    status: await readDaemonStatus(paths),
  };
}

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Adapter } from '../adapters/index.js';
import type { Config } from '../config.js';
import type { TrovePaths } from '../paths.js';
import type { RemoteStore } from '../remote/store.js';
import { intParam, json, notFound, param, readBody } from './http.js';
import { listLessons, readLessonFile } from './lessons.js';
import { buildOverview } from './overview.js';
import { listSkills, readSkillFile } from './skills.js';
import { getSessionDetail, getSessionEvents, listSessionsPage } from './sessions.js';
import { buildUsage } from './usage.js';
import { serveStatic } from './static.js';
import { resolveRawSync } from '../config.js';
import { runSyncOnce } from '../runtime.js';
import { SyncJob, type SyncRunner } from './sync.js';
import { daemonState, restartDaemon } from '../daemon.js';
import { libraryLessonsDir } from '../core/layout.js';
import { LocalStorageAdapter } from '../core/lessons/storage.js';
import { readLearnConfig } from '../core/lessons/config.js';
import { buildMemoryHealth } from '../core/lessons/health.js';
import { runCurator } from '../core/lessons/curator.js';

export interface DaemonControl {
  restart(): Promise<{ pid: number; wasRunning: boolean }>;
}

export interface ServerOptions {
  paths: TrovePaths;
  config: Config;
  remote: RemoteStore | null;
  adapters: Adapter[];
  /** 0 = 随机端口(测试用)。 */
  port?: number;
  now?: () => number;
  /** 同步执行器;测试注入假实现,默认走 core 的 sync()。 */
  runSync?: SyncRunner;
  /** daemon 生命周期控制;测试注入,默认走 daemon 模块。 */
  daemonControl?: DaemonControl;
  /** 撞锁后多久探一次锁(默认 2s)。 */
  retryDelayMs?: number;
  /** 撞锁后最多等多久(默认 120s)。 */
  maxWaitMs?: number;
  /** 前端构建产物目录;缺省是 dist/public(与编译产物同根)。 */
  publicDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * 启动 web 后端。只监听回环地址 —— vault 里有全部会话正文,
 * config 里有明文远端凭证,这个服务没有鉴权,暴露到局域网等于泄密。
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const now = opts.now ?? Date.now;
  const jobs = new Map<string, SyncJob>();
  const state: ServerState = {
    jobs,
    runSync:
      opts.runSync ??
      ((progress) =>
        runSyncOnce({ paths: opts.paths, runtime: { config: opts.config, remote: opts.remote, adapters: opts.adapters }, progress, now })),
    daemonControl:
      opts.daemonControl ??
      ({
        restart: async () =>
          restartDaemon({
            paths: opts.paths,
            intervalSeconds: opts.config.daemon.intervalSeconds,
            since: opts.config.daemon.since,
            raw: resolveRawSync(opts.config),
            env: { ...process.env },
          }),
      } as DaemonControl),
    retryDelayMs: opts.retryDelayMs ?? 2000,
    maxWaitMs: opts.maxWaitMs ?? 120_000,
  };
  const publicDir = opts.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url));
  let boundPort = opts.port ?? 8787;
  const server = createServer((req, res) => {
    void handle(req, res, opts, state, now, publicDir, boundPort);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  boundPort = addr.port;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ServerState {
  jobs: Map<string, SyncJob>;
  runSync: SyncRunner;
  daemonControl: DaemonControl;
  retryDelayMs: number;
  maxWaitMs: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Host 必须是回环地址且端口匹配,挡住 DNS rebinding。 */
function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  let u: URL;
  try {
    u = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) return false;
  return u.port === '' ? port === 80 : Number(u.port) === port;
}

/** Origin 缺失(非浏览器/本地 CLI)或与本机同源才放行,挡住跨站 POST。 */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return false;
  return u.port !== '' && Number(u.port) === port;
}

async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  opts: ServerOptions,
  state: ServerState,
  now: () => number,
  publicDir: string,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (!hostAllowed(req.headers.host, port) || !originAllowed(req.headers.origin, port)) {
      json(res, 403, { error: '只接受本机同源请求' });
      return;
    }
    if (url.pathname === '/api/overview') {
      json(res, 200, await buildOverview({ ...opts, now }));
      return;
    }
    if (url.pathname === '/api/sessions') {
      json(
        res,
        200,
        await listSessionsPage(opts.paths.vault, {
          ...(param(url, 'harness') ? { harness: param(url, 'harness') } : {}),
          ...(param(url, 'device') ? { device: param(url, 'device') } : {}),
          ...(param(url, 'q') ? { q: param(url, 'q') } : {}),
          limit: intParam(url, 'limit', 100),
          offset: intParam(url, 'offset', 0),
        }),
      );
      return;
    }
    // /api/sessions/{key} 与 /api/sessions/{key}/events
    // key 形如 harness:session,用 encodeURIComponent 放在一段里(切分先于解码)
    const segs = url.pathname.split('/');
    if (segs[2] === 'sessions' && segs[3]) {
      const key = decodeURIComponent(segs[3]);
      if (segs.length === 4) {
        const detail = await getSessionDetail(opts.paths.vault, key);
        if (!detail) notFound(res, '这个会话');
        else json(res, 200, detail);
        return;
      }
      if (segs.length === 5 && segs[4] === 'events') {
        const page = await getSessionEvents(
          opts.paths.vault,
          key,
          intParam(url, 'offset', 0),
          intParam(url, 'limit', 200),
        );
        if (!page) notFound(res, '这个会话');
        else json(res, 200, page);
        return;
      }
    }
    if (url.pathname === '/api/lessons') {
      json(res, 200, await listLessons(opts.paths.vault));
      return;
    }
    if (url.pathname === '/api/lessons/file') {
      const rel = param(url, 'path');
      const file = rel ? await readLessonFile(opts.paths.vault, rel) : null;
      if (!file) notFound(res, '这条记忆');
      else json(res, 200, file);
      return;
    }
    if (url.pathname === '/api/skills') {
      json(res, 200, await listSkills(opts.paths.vault));
      return;
    }
    if (url.pathname === '/api/skills/file') {
      const name = param(url, 'name');
      const hash = param(url, 'hash');
      const rel = param(url, 'rel');
      const file =
        name && hash && rel ? await readSkillFile(opts.paths.vault, name, hash, rel) : null;
      if (!file) notFound(res, '这个技能文件');
      else json(res, 200, file);
      return;
    }
    if (url.pathname === '/api/usage') {
      json(res, 200, await buildUsage(opts.paths));
      return;
    }
    if (url.pathname === '/api/health') {
      json(res, 200, await buildMemoryHealth(opts.paths, now));
      return;
    }
    if (url.pathname === '/api/curator' && req.method === 'POST') {
      const storage = new LocalStorageAdapter(libraryLessonsDir(opts.paths.vault));
      const learn = readLearnConfig(opts.config);
      let dryRun = true;
      try {
        const raw = await readBody(req);
        const parsed = raw.trim() ? (JSON.parse(raw) as { dryRun?: unknown }) : {};
        dryRun = parsed.dryRun !== false;
      } catch {
        // 无体或非法 JSON:保持默认 dry-run
      }
      const report = await runCurator(storage, { ...learn.lifecycle, dryRun, now: () => new Date(now()) });
      json(res, 200, report);
      return;
    }
    if (url.pathname === '/api/daemon') {
      json(res, 200, await daemonState(opts.paths));
      return;
    }
    if (url.pathname === '/api/daemon/restart' && req.method === 'POST') {
      json(res, 200, await state.daemonControl.restart());
      return;
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const job = new SyncJob({
        runner: state.runSync,
        lockPath: `${opts.paths.state}.lock`,
        retryDelayMs: state.retryDelayMs,
        maxWaitMs: state.maxWaitMs,
      });
      state.jobs.set(job.id, job);
      void job.run();
      json(res, 202, { jobId: job.id });
      return;
    }
    if (url.pathname.startsWith('/api/sync/') && url.pathname.endsWith('/events')) {
      const id = url.pathname.slice('/api/sync/'.length, -'/events'.length);
      const job = state.jobs.get(id);
      if (!job) {
        notFound(res, '这次同步');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      for await (const e of job.read()) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      notFound(res, '这个接口');
      return;
    }
    if (await serveStatic(publicDir, url.pathname, res)) return;
    json(res, 404, { error: '界面还没构建。开发时跑 pnpm dev,发布前跑 pnpm build。' });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
}

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { password as clackPassword, text } from '@clack/prompts';
import pc from 'picocolors';
import { trovePaths } from './paths.js';
import { defaultConfig, loadConfig, resolveRawSync, saveConfig, type Config } from './config.js';
import { loadState } from './core/state.js';
import { sync } from './core/sync.js';
import { listSessions } from './core/sessions.js';
import { ensureLibraryLayout, cleanupLegacyEvents, migrateLegacyLayout, librarySkillsDir, safeSessionName } from './core/layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from './core/library/index-file.js';
import { parseSince, formatSince } from './core/time-window.js';
import { computeOtherDevices, computeStatus, type StatusReport } from './status.js';
import { humanSize } from './format.js';
import { WebDavStore } from './remote/webdav-store.js';
import type { RemoteStore } from './remote/store.js';
import type { Adapter } from './adapters/index.js';
import { createAdapters } from './adapters/index.js';
import { createConsoleProgress } from './progress-console.js';
import { silentProgress } from './progress.js';
import {
  daemonState,
  runDaemon,
  startDaemon,
  stopDaemon,
  type DaemonRuntime,
} from './daemon.js';

export const VERSION = '0.2.0';

export interface CliDeps {
  base?: string;
  createRemote?: (url: string, username: string, password: string) => RemoteStore;
  resolveAdapters?: (config: Config) => Adapter[];
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 原始输出(进度行需要 \r),默认 process.stdout.write */
  rawOut?: (text: string) => void;
  isTTY?: boolean;
  now?: () => number;
}

function defaultCreateRemote(url: string, username: string, password: string): RemoteStore {
  return new WebDavStore({ url, username, password });
}

function defaultResolveAdapters(config: Config): Adapter[] {
  return createAdapters().filter((a) => config.sources[a.id]?.enabled !== false);
}

function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => {
    if (o == null) return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatStatus(
  r: StatusReport,
  others: Array<{ name: string; sessionCount: number; bytes: number }> = [],
): string {
  const lines: string[] = [pc.bold(`设备 ${r.deviceName} (${r.deviceId})`), '', pc.bold('已归档')];
  for (const h of r.harnesses) {
    lines.push(
      `  ${h.displayName.padEnd(12)} ${pc.green(`${h.sessionCount} 个会话`)} · ${humanSize(h.bytes)}`,
    );
  }
  if (others.length) {
    lines.push('', pc.bold('其他设备'));
    for (const d of others) {
      lines.push(
        `  ${d.name.padEnd(12)} ${pc.green(`${d.sessionCount} 个会话`)} · ${humanSize(d.bytes)}`,
      );
    }
  }
  lines.push('');
  lines.push(
    r.pendingCount > 0
      ? `待同步 ${pc.yellow(`${r.pendingCount} 项`)} · ${humanSize(r.pendingBytes)}`
      : '待同步 无',
  );
  return lines.join('\n');
}

function looksLikeDateWindow(since: string): string {
  return since === 'all' ? 'all' : since;
}

async function loadRuntime(
  paths: ReturnType<typeof trovePaths>,
  createRemote: (url: string, username: string, password: string) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
): Promise<{
  config: Config;
  remote: RemoteStore;
  adapters: Adapter[];
}> {
  const config = await loadConfig(paths.config);
  if (!config.remote.url) throw new Error('尚未配置远端 URL,先运行 `trove init`。');
  if (!config.remote.password) throw new Error('未配置密码,先运行 `trove init`。');
  const remote = createRemote(config.remote.url, config.remote.username, config.remote.password);
  return { config, remote, adapters: resolveAdapters(config) };
}

async function cmdSync(
  opts: {
    since?: string;
    pullOnly?: boolean;
    pushOnly?: boolean;
    quiet?: boolean;
    rawExplicit?: boolean;
  },
  paths: ReturnType<typeof trovePaths>,
  createRemote: (url: string, username: string, password: string) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  out: (l: string) => void,
  rawOut: (s: string) => void,
  tty: boolean,
  now: () => number,
): Promise<void> {
  const { config, remote, adapters } = await loadRuntime(paths, createRemote, resolveAdapters);
  const since = opts.since ?? 'all';
  const cutoff = parseSince(since, now());
  const progress = opts.quiet
    ? silentProgress
    : createConsoleProgress({ write: rawOut, tty, now });
  const rawSync = resolveRawSync(config, opts.rawExplicit);

  const report = await sync({
    adapters,
    deviceId: config.device.id,
    deviceName: config.device.name,
    vaultRoot: paths.vault,
    statePath: paths.state,
    tmpDir: paths.tmp,
    remote,
    cutoff,
    progress,
    now,
    pullOnly: opts.pullOnly,
    pushOnly: opts.pushOnly,
    rawSync,
  });

  const c = report.collected;
  out(
    `发现 ${c.discovered} 项 · 会话 ${c.sessions} · 归档 ${c.archived} · 追加 ${c.appended} · ` +
      `跳过 ${c.skipped} · 窗口外 ${c.outOfWindow}`,
  );
  out(
    `拉取 ${report.pulled.downloadedItems} 项 (${humanSize(report.pulled.downloadedBytes)}) · ` +
      `推送 ${report.pushed.uploadedItems} 项 (${humanSize(report.pushed.uploadedBytes)}) · ` +
      `跳过 ${report.pushed.skippedItems}`,
  );
  out(
    `库: 拉取 ${report.library.pulled.downloaded} 项 · ` +
      `推送 ${report.library.pushed.uploaded} 项 (${humanSize(report.library.pushed.bytes)})`,
  );
  out(
    pc.green(
      `同步完成${rawSync ? '' : ' · 仅 library'} · ${formatSince(cutoff)} · ` +
        `${(report.durationMs / 1000).toFixed(1)}s`,
    ),
  );
}

async function cmdSessions(
  opts: { harness?: string; device?: string; grep?: string; limit?: string; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const all = await listSessions(paths.vault, {
    harness: opts.harness,
    device: opts.device,
    grep: opts.grep,
  });
  const limit = opts.limit === undefined ? 50 : Math.max(0, Number(opts.limit) || 0);
  const list = limit > 0 ? all.slice(0, limit) : all;

  if (opts.json) {
    out(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    out('没有匹配的会话。');
    return;
  }
  for (const s of list) {
    const when = s.startedAt ? s.startedAt.replace('T', ' ').slice(0, 16) : '时间未知';
    out(
      `${pc.dim(when)}  ${s.harness.padEnd(12)} ${pc.green(s.session.slice(0, 12))}  ` +
        `${s.title ?? s.firstText ?? ''}`,
    );
    const sub = [s.cwd, s.model, humanSize(s.bytes)].filter(Boolean).join(' · ');
    if (sub) out(`  ${pc.dim(sub)}`);
  }
  out('');
  out(
    pc.dim(
      `${all.length} 个会话` +
        (all.length > list.length ? `(显示前 ${list.length} 个,用 --limit 调整)` : ''),
    ),
  );
}

async function cmdSkillsList(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  json: boolean,
): Promise<void> {
  const index = (await loadLibraryIndex(paths.vault)) ?? (await rebuildUnifiedIndex(paths.vault));
  const list = Object.values(index.skills).sort((a, b) => a.name.localeCompare(b.name));
  if (json) {
    out(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    out('还没有汇总的技能。');
    return;
  }
  for (const skill of list) {
    const latest = skill.versions.find((v) => v.hash === skill.latest)!;
    const version = latest.version ? `v${latest.version}` : '未标版本';
    out(
      `${skill.name.padEnd(28)} ${version.padEnd(12)} ${latest.source.padEnd(8)} ` +
        `${skill.versions.length} 个版本 · ${latest.devices.join(',')}`,
    );
    if (latest.origin) out(`  ${pc.dim(latest.origin)}`);
  }
  out('');
  out(pc.dim(`${list.length} 个技能`));
}

async function cmdSkillsShow(
  paths: ReturnType<typeof trovePaths>,
  name: string,
  out: (l: string) => void,
): Promise<void> {
  const index = (await loadLibraryIndex(paths.vault)) ?? (await rebuildUnifiedIndex(paths.vault));
  const skill = index.skills[name];
  if (!skill) {
    out(`没有找到技能: ${name}`);
    return;
  }
  out(pc.bold(skill.name));
  for (const v of skill.versions) {
    const mark = v.hash === skill.latest ? pc.green('latest') : '      ';
    out(
      `  ${mark} ${v.hash.slice(0, 12)}  ${(v.version ?? '-').padEnd(10)} ${v.source.padEnd(8)} ` +
        `${v.devices.join(',')}  ${v.updatedAt ?? ''}`,
    );
    if (v.origin) out(`         ${pc.dim(v.origin)}`);
  }
  const latest = skill.versions.find((v) => v.hash === skill.latest);
  if (latest) {
    out('');
    out(
      pc.dim(
        join(librarySkillsDir(paths.vault), safeSessionName(skill.name), 'versions', latest.hash),
      ),
    );
  }
}

async function cmdLibraryReindex(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  await ensureLibraryLayout(paths.vault);
  const index = await rebuildUnifiedIndex(paths.vault);
  out(
    pc.green(
      `索引已重建: ${Object.keys(index.sessions).length} 个会话 · ` +
        `${Object.keys(index.skills).length} 个技能 · ${index.hash.slice(0, 12)}`,
    ),
  );
}

async function cmdStatus(
  paths: ReturnType<typeof trovePaths>,
  resolveAdapters: (config: Config) => Adapter[],
  out: (l: string) => void,
): Promise<void> {
  const config = await loadConfig(paths.config);
  const state = await loadState(paths.state);
  const adapters = resolveAdapters(config);
  const report = computeStatus({
    state,
    deviceId: config.device.id,
    deviceName: config.device.name,
    adapters,
  });
  const others = await computeOtherDevices(paths.vault, config.device.id, adapters);
  out(formatStatus(report, others));
  const index = await loadLibraryIndex(paths.vault);
  if (index) {
    out('');
    out(
      `库 ${pc.green(`${Object.keys(index.sessions).length} 个会话`)} · ` +
        `${Object.keys(index.skills).length} 个技能 · 索引 ${index.hash.slice(0, 12)}`,
    );
  }
}

interface InitOptions {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
}

function isCancel(v: unknown): v is symbol {
  return typeof v === 'symbol';
}

export async function resolveInitInputs(opts: InitOptions, interactive = false) {
  const name =
    opts.name ?? (interactive ? await text({ message: '设备名', initialValue: hostname() }) : hostname());
  const username =
    opts.username ??
    (interactive ? await text({ message: 'WebDAV 用户名', initialValue: 'webdav' }) : 'webdav');
  const url =
    opts.url ??
    (interactive
      ? await text({ message: 'WebDAV 地址', placeholder: 'https://dav.example.com/trove/' })
      : undefined);
  const password =
    opts.password ??
    process.env.TROVE_PASSWORD ??
    (interactive ? await clackPassword({ message: 'WebDAV 密码' }) : undefined);
  return { name, url, username, password };
}

async function cmdInit(
  opts: InitOptions,
  paths: ReturnType<typeof trovePaths>,
  createRemote: (url: string, username: string, password: string) => RemoteStore,
  out: (l: string) => void,
  err: (l: string) => void,
  interactive: boolean,
): Promise<number> {
  const { name, url, username, password } = await resolveInitInputs(opts, interactive);
  if ([name, url, username, password].some(isCancel)) {
    err('已取消。');
    return 1;
  }
  if (!url) throw new Error('需要 WebDAV 地址(--url)。');
  if (!password) throw new Error('未提供密码(--password 或 TROVE_PASSWORD)。');

  const existing = await loadConfig(paths.config);
  const config = defaultConfig({ deviceId: existing.device.id, deviceName: name as string });
  config.remote = { url: url as string, username: username as string, password: password as string };

  const remote = createRemote(url as string, username as string, password as string);
  await mkdir(paths.tmp, { recursive: true });
  const probePath = `.trove-probe/${randomUUID()}.json`;
  const probeLocal = join(paths.tmp, `probe-${randomUUID()}.json`);
  await writeFile(probeLocal, '{"probe":true}\n');
  await remote.writeFile(probePath, probeLocal);
  const echoed = await remote.readJson(probePath);
  await remote.delete(probePath);
  await rm(probeLocal, { force: true });
  if (!echoed) throw new Error('连通性探针失败:写入的文件读不回来。');

  await saveConfig(paths.config, config);
  out(pc.green('初始化完成'));
  out(`  设备: ${name as string} (${config.device.id})`);
  out(`  远端: ${url as string}`);
  return 0;
}

function daemonRuntime(
  paths: ReturnType<typeof trovePaths>,
  opts: { interval: string; since: string; rawExplicit?: boolean },
  createRemote: (url: string, username: string, password: string) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  now: () => number,
): DaemonRuntime {
  const intervalSeconds = Math.max(5, Number(opts.interval) || 300);
  return {
    paths,
    intervalSeconds,
    since: opts.since,
    runOnce: async (progress, signal) => {
      const { config, remote, adapters } = await loadRuntime(paths, createRemote, resolveAdapters);
      return sync({
        adapters,
        deviceId: config.device.id,
        deviceName: config.device.name,
        vaultRoot: paths.vault,
        statePath: paths.state,
        tmpDir: paths.tmp,
        remote,
        cutoff: parseSince(opts.since, now()),
        progress,
        now,
        rawSync: resolveRawSync(config, opts.rawExplicit),
        signal,
      });
    },
  };
}

/** 主入口:用 commander 定义命令并分发。返回进程退出码。 */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const rawOut = deps.rawOut ?? ((s: string) => process.stdout.write(s));
  const paths = trovePaths(deps.base);
  const createRemote = deps.createRemote ?? defaultCreateRemote;
  const resolveAdapters = deps.resolveAdapters ?? defaultResolveAdapters;
  const now = deps.now ?? Date.now;
  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const tty = deps.isTTY ?? Boolean(process.stdout.isTTY);

  const program = new Command();
  program
    .name('trove')
    .description('AI 会话资产归档与多设备同步')
    .version(VERSION);

  program
    .command('init')
    .description('首次配置(设备名、WebDAV 端点、凭证)')
    .option('--name <name>', '设备名')
    .option('--url <url>', 'WebDAV 地址')
    .option('--username <user>', 'WebDAV 用户名')
    .option('--password <pass>', 'WebDAV 密码(也可用 TROVE_PASSWORD 环境变量)')
    .action(async (opts: InitOptions) => {
      const code = await cmdInit(opts, paths, createRemote, out, err, interactive);
      if (code !== 0) process.exitCode = code;
    });

  const configCmd = program.command('config').description('查看/修改配置');
  configCmd
    .command('path')
    .description('打印配置文件路径')
    .action(() => out(paths.config));
  configCmd
    .command('get <key>')
    .description('读取配置项(点路径,如 device.name)')
    .action(async (key: string) => {
      const config = await loadConfig(paths.config);
      const v = getPath(config, key);
      out(v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    });
  configCmd
    .command('set <key> <value>')
    .description('写入配置项(JSON 值)')
    .action(async (key: string, value: string) => {
      const config = await loadConfig(paths.config);
      setPath(config as unknown as Record<string, unknown>, key, parseValue(value));
      await saveConfig(paths.config, config);
    });

  program
    .command('sync')
    .description('收集本机会话并同步远端 (collect → pull → push)')
    .option('--since <range>', '只收集最近变更的会话:7d / 24h / 2026-10-01 / all', 'all')
    .option('--pull-only', '只拉取')
    .option('--push-only', '只推送')
    .option('--raw', '同步 raw(覆盖配置)')
    .option('--no-raw', '只同步 library(raw 只归档到本地,不上传/不拉取)')
    .option('--quiet', '不显示逐项进度')
    .action(
      async function (
        this: Command,
        opts: {
          since: string;
          pullOnly?: boolean;
          pushOnly?: boolean;
          raw?: boolean;
          quiet?: boolean;
        },
      ) {
        const rawExplicit =
          this.getOptionValueSource('raw') === 'cli' ? opts.raw === true : undefined;
        await cmdSync(
          { ...opts, rawExplicit },
          paths,
          createRemote,
          resolveAdapters,
          out,
          rawOut,
          tty,
          now,
        );
      },
    );

  program
    .command('sessions')
    .description('列出/检索 library 会话')
    .option('--harness <id>', '只看某个工具:claude-code / codex / opencode / doubao')
    .option('--device <id>', '只看某台设备')
    .option('--grep <text>', '按标题/摘要/目录/模型搜索')
    .option('--limit <n>', '最多显示多少条(0 = 全部)', '50')
    .option('--json', '输出 JSON')
    .action(
      async (opts: {
        harness?: string;
        device?: string;
        grep?: string;
        limit?: string;
        json?: boolean;
      }) => {
        await cmdSessions(opts, paths, out);
      },
    );

  program
    .command('skills')
    .description('查看汇总后的技能')
    .argument('[action]', 'list(默认) / show', 'list')
    .argument('[name]', '技能名(show 时必填)')
    .option('--json', '输出 JSON')
    .action(async (action: string, name: string | undefined, opts: { json?: boolean }) => {
      if (action === 'show' || action === 'list') {
        if (action === 'show') {
          if (!name) {
            err('用法: trove skills show <name>');
            return;
          }
          await cmdSkillsShow(paths, name, out);
        } else {
          await cmdSkillsList(paths, out, Boolean(opts.json));
        }
        return;
      }
      err(`未知的 skills 子命令: ${action}`);
    });

  const libraryCmd = program.command('library').description('个人资产层管理');
  libraryCmd
    .command('reindex')
    .description('从设备分片重建统一索引')
    .action(async () => {
      await cmdLibraryReindex(paths, out);
    });

  program
    .command('status')
    .description('概览(各工具会话数、待同步)')
    .action(async () => {
      await cmdStatus(paths, resolveAdapters, out);
    });

  const daemonCmd = program.command('daemon').description('常驻后台同步服务');

  daemonCmd
    .command('start')
    .description('后台启动 daemon')
    .option('--interval <seconds>', '轮询间隔秒数', '300')
    .option('--since <range>', '只收集最近变更的会话', '7d')
    .option('--raw', '同步 raw(覆盖配置)')
    .option('--no-raw', '只同步 library(raw 只归档到本地)')
    .action(async function (this: Command, opts: { interval: string; since: string; raw?: boolean }) {
      parseSince(opts.since, now()); // 启动前校验,避免子进程每轮都失败
      const interval = Math.max(5, Number(opts.interval) || 300);
      const rawExplicit =
        this.getOptionValueSource('raw') === 'cli' ? opts.raw === true : undefined;
      const pid = await startDaemon({
        paths,
        intervalSeconds: interval,
        since: opts.since,
        raw: rawExplicit,
      });
      out(pc.green(`daemon 已启动 (pid ${pid}) · 每 ${interval}s · 时间窗 ${looksLikeDateWindow(opts.since)}`));
    });

  daemonCmd
    .command('stop')
    .description('优雅停止 daemon')
    .action(async () => {
      const stopped = await stopDaemon(paths);
      out(stopped ? pc.green('daemon 已停止') : 'daemon 未运行');
    });

  daemonCmd
    .command('status')
    .description('查看 daemon 状态')
    .action(async () => {
      const s = await daemonState(paths);
      if (!s.running) {
        out('daemon 未运行');
        return;
      }
      out(pc.green(`daemon 运行中 (pid ${s.pid})`));
      if (s.status?.lastRunAt) {
        const ago = Math.round((now() - s.status.lastRunAt) / 1000);
        out(`  上次同步: ${ago}s 前 · 耗时 ${s.status.lastDurationMs ?? 0}ms`);
      }
      if (s.status?.lastResult) {
        const c = s.status.lastResult;
        out(
          `  结果: 收集 ${c.collected.archived} · 拉取 ${c.pulled.downloadedItems} · ` +
            `推送 ${c.pushed.uploadedItems}`,
        );
      }
      if (s.status?.lastError) out(pc.yellow(`  最近错误: ${s.status.lastError}`));
    });

  daemonCmd
    .command('run', { hidden: true })
    .description('前台运行(daemon start 内部使用)')
    .option('--interval <seconds>', '轮询间隔秒数', '300')
    .option('--since <range>', '只收集最近变更的会话', '7d')
    .option('--raw', '同步 raw(覆盖配置)')
    .option('--no-raw', '只同步 library(raw 只归档到本地)')
    .action(async function (this: Command, opts: { interval: string; since: string; raw?: boolean }) {
      parseSince(opts.since, now());
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      const rawExplicit =
        this.getOptionValueSource('raw') === 'cli' ? opts.raw === true : undefined;
      await runDaemon(
        daemonRuntime(paths, { ...opts, rawExplicit }, createRemote, resolveAdapters, now),
        controller.signal,
      );
    });

  program.configureOutput({
    writeOut: (str: string) => out(str.replace(/\n+$/, '')),
    writeErr: (str: string) => err(str.replace(/\n+$/, '')),
  });
  program.exitOverride();

  try {
    await migrateLegacyLayout(paths.vault);
    await cleanupLegacyEvents(paths.vault);
    await ensureLibraryLayout(paths.vault);
    await program.parseAsync(['node', 'trove', ...argv]);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
      return 1;
    }
    err(pc.red(`错误: ${(e as Error).message}`));
    return 1;
  }
}

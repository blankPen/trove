import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { password as clackPassword, text } from '@clack/prompts';
import pc from 'picocolors';
import { trovePaths } from './paths.js';
import { defaultConfig, loadConfig, saveConfig, type Config } from './config.js';
import { loadManifest } from './manifest.js';
import { computeStatus, type StatusReport } from './status.js';
import { humanSize } from './format.js';
import { collectSource } from './collect.js';
import { sync } from './sync.js';
import { WebDavRemote } from './remote/webdav.js';
import type { Remote } from './remote/types.js';
import type { Source } from './adapters/types.js';
import { createClaudeCodeSource } from './adapters/claude-code.js';

export const VERSION = '0.1.0';

/** 远端/输出等依赖,测试时可注入 fake。 */
export interface CliDeps {
  base?: string;
  createRemote?: (url: string, username: string, password: string) => Remote;
  resolveSources?: (config: Config) => Source[];
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function defaultCreateRemote(url: string, username: string, password: string): Remote {
  return new WebDavRemote({ url, username, password });
}

function defaultResolveSources(config: Config): Source[] {
  const out: Source[] = [];
  if (config.sources['claude-code']?.enabled) out.push(createClaudeCodeSource());
  for (const id of ['codex', 'doubao'] as const) {
    if (config.sources[id]?.enabled) {
      throw new Error(`数据源 "${id}" 的 adapter 尚未实现(设计阶段 5)。`);
    }
  }
  return out;
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

function formatStatus(r: StatusReport): string {
  const lines: string[] = [pc.bold(`设备 ${r.deviceName} (${r.deviceId})`), '', pc.bold('本地归档')];
  for (const d of r.devices) {
    lines.push(`  ${d.name}`);
    for (const h of d.harnesses) {
      lines.push(`    ${h.displayName}  ${pc.green(`${h.sessionCount} 个会话`)} · ${humanSize(h.bytes)}`);
    }
  }
  lines.push('');
  lines.push(
    r.pendingCount > 0
      ? `待同步 ${pc.yellow(`${r.pendingCount} 个文件`)} · ${humanSize(r.pendingBytes)}`
      : '待同步 无',
  );
  return lines.join('\n');
}

async function cmdStatus(paths: ReturnType<typeof trovePaths>, out: (l: string) => void): Promise<void> {
  const config = await loadConfig(paths.config);
  const manifest = await loadManifest(paths.manifest);
  // v1 仅 Claude Code;codex/doubao adapter 落地(设计阶段 5)后再追加。
  const cc = createClaudeCodeSource();
  const report = await computeStatus({
    vaultRoot: paths.vault,
    deviceId: config.device.id,
    deviceName: config.device.name,
    manifest,
    harnesses: [{ id: cc.id, displayName: cc.displayName, sessionGlob: cc.sessionGlob }],
  });
  out(formatStatus(report));
}

async function cmdSync(
  opts: { dryRun?: boolean; pullOnly?: boolean; pushOnly?: boolean },
  paths: ReturnType<typeof trovePaths>,
  createRemote: (url: string, username: string, password: string) => Remote,
  resolveSources: (config: Config) => Source[],
  out: (l: string) => void,
): Promise<void> {
  const config = await loadConfig(paths.config);
  if (!config.remote.url) throw new Error('尚未配置远端 URL,先运行 `trove init`。');
  const { username, password } = config.remote;
  if (!password) {
    throw new Error('未配置密码,先运行 `trove init`。');
  }
  const remote = createRemote(config.remote.url, username, password);

  // ① collect:把本机 agent 源汇总进 vault(设计 §10.3 ① SCAN);dry-run 不落盘
  let collected = 0;
  if (!opts.dryRun) {
    for (const source of resolveSources(config)) {
      const r = await collectSource({ source, deviceId: config.device.id, vaultRoot: paths.vault });
      collected += r.copied;
    }
  }

  // ② sync:pull → push
  const report = await sync({
    remote,
    deviceId: config.device.id,
    deviceName: config.device.name,
    vaultRoot: paths.vault,
    manifestPath: paths.manifest,
    dryRun: opts.dryRun,
    pullOnly: opts.pullOnly,
    pushOnly: opts.pushOnly,
  });
  out(pc.green(`已收集 ${collected} · 已同步: 拉取 ${report.pulled} · 推送 ${report.pushed} · 跳过 ${report.skipped}`));
}

interface InitOptions {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
}

/** @clack 取消(ESC)返回的标记。 */
function isCancel(v: unknown): v is symbol {
  return typeof v === 'symbol';
}

export async function resolveInitInputs(opts: InitOptions, interactive = false) {
  // 交互模式下:name/username 带默认值询问(可改),url/password 无默认值必问。
  // 非交互模式(管道/CI):name/username 用默认值,url/password 缺失则交由调用方报错。
  const name = opts.name ?? (interactive
    ? await text({ message: '设备名', initialValue: hostname() })
    : hostname());
  const username = opts.username ?? (interactive
    ? await text({ message: 'WebDAV 用户名', initialValue: 'webdav' })
    : 'webdav');
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
  createRemote: (url: string, username: string, password: string) => Remote,
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

  // 复用已有设备 id,避免重复 init 换号
  const existing = await loadConfig(paths.config);
  const config = defaultConfig({ deviceId: existing.device.id, deviceName: name as string });
  config.remote.url = url as string;
  config.remote.username = username as string;
  config.remote.password = password as string;

  // 连通性探针(设计 §10.1):写 → 读回确认 → 删,避免裸奔端点误判
  const remote = createRemote(url as string, username as string, password as string);
  await mkdir(paths.tmp, { recursive: true });
  const probePath = `.trove-probe/${randomUUID()}.jsonl`;
  const probeLocal = join(paths.tmp, `probe-${randomUUID()}.jsonl`);
  await writeFile(probeLocal, 'probe\n');
  await remote.upload(probeLocal, probePath);
  const listed = (await remote.listAll()).some((f) => f.path === probePath);
  await remote.delete(probePath);
  await rm(probeLocal, { force: true });
  if (!listed) throw new Error('连通性探针失败:写入的文件未出现在远端 listAll。');

  await saveConfig(paths.config, config);
  out(pc.green('初始化完成'));
  out(`  设备: ${name as string} (${config.device.id})`);
  out(`  远端: ${url as string}`);
  return 0;
}

/** 主入口:用 commander 定义命令并分发。返回进程退出码。 */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const paths = trovePaths(deps.base);
  const createRemote = deps.createRemote ?? defaultCreateRemote;
  const resolveSources = deps.resolveSources ?? defaultResolveSources;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const program = new Command();
  program
    .name('trove')
    .description('Claude Code 会话归档与多设备同步')
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
    .action(() => {
      out(paths.config);
    });
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
    .description('写入配置项(JSON 值,如 "60" 会存数字)')
    .action(async (key: string, value: string) => {
      const config = await loadConfig(paths.config);
      setPath(config as unknown as Record<string, unknown>, key, parseValue(value));
      await saveConfig(paths.config, config);
    });

  program
    .command('sync')
    .description('收集本机会话入 vault,再同步远端 (collect → pull → push)')
    .option('--dry-run', '只计划不执行')
    .option('--pull-only', '只拉取')
    .option('--push-only', '只推送')
    .action(async (opts: { dryRun?: boolean; pullOnly?: boolean; pushOnly?: boolean }) => {
      await cmdSync(opts, paths, createRemote, resolveSources, out);
    });

  program
    .command('status')
    .description('概览(各设备会话数、待同步)')
    .action(async () => {
      await cmdStatus(paths, out);
    });

  program.configureOutput({
    writeOut: (str: string) => out(str.replace(/\n+$/, '')),
    writeErr: (str: string) => err(str.replace(/\n+$/, '')),
  });
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'trove', ...argv]);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      const code = e.code;
      // help / version 是正常退出
      if (code === 'commander.helpDisplayed' || code === 'commander.version') return 0;
      // 其它(unknown command / missing argument 等)已由 configureOutput 输出
      return 1;
    }
    err(pc.red(`错误: ${(e as Error).message}`));
    return 1;
  }
}

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { confirm, password as clackPassword, text } from '@clack/prompts';
import pc from 'picocolors';
import { trovePaths } from './paths.js';
import { loadConfig, resolveRawSync, saveConfig, type Config, type RemoteConfig } from './config.js';
import { loadState } from './core/state.js';
import { sync } from './core/sync.js';
import { deleteOrphans, scanOrphans, type OrphanCategory, type OrphanScan } from './core/clean.js';
import { listSessions } from './core/sessions.js';
import { ensureLibraryLayout, cleanupLegacyEvents, migrateLegacyLayout, librarySkillsDir, libraryLessonsDir, safeSessionName } from './core/layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from './core/library/index-file.js';
import { parseSince, formatSince } from './core/time-window.js';
import {
  computeLessonsSummary,
  computeLibraryPending,
  computeStatus,
  probeRemote,
  type LessonsSummary,
  type RemoteStatus,
  type StatusReport,
} from './status.js';
import { humanSize, humanSpan } from './format.js';
import {
  createRemoteFromConfig,
  describeRemote,
  isRemoteConfigured,
  remoteIdentity,
} from './remote/create-remote.js';
import { promptRemoteConfig } from './remote/prompt.js';
import type { RemoteStore } from './remote/store.js';
import type { Adapter } from './adapters/index.js';
import { createAdapters } from './adapters/index.js';
import { createConsoleProgress } from './progress-console.js';
import { silentProgress } from './progress.js';
import { formatDiff, readLatestDiff, readSessionDiff } from './core/lessons/audit.js';
import { LocalStorageAdapter } from './core/lessons/storage.js';
import { refreshSidecars } from './core/lessons/sidecar.js';
import { runLessonExtraction, learnPendingBatch, learnRecentBatch } from './core/lessons/learn.js';
import type { LessonProviderDeps } from './core/lessons/learn.js';
import { formatUsageSummary, readUsageRecords, summarizeUsage } from './core/lessons/usage.js';
import { learnClaudeMemo } from './core/lessons/memo.js';
import { learnRecentMatters } from './core/lessons/recent.js';
import { enqueueLearn, readLearnQueue } from './core/lessons/queue.js';
import {
  daemonState,
  daemonLog,
  runDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type DaemonRuntime,
  type RestartDaemonOptions,
  type StartDaemonOptions,
} from './daemon.js';

export const VERSION = '0.2.0';

export interface CliDeps {
  base?: string;
  /** 按配置构造远端;测试注入 stub。 */
  createRemote?: (config: RemoteConfig) => RemoteStore;
  resolveAdapters?: (config: Config) => Adapter[];
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 原始输出(进度行需要 \r),默认 process.stdout.write */
  rawOut?: (text: string) => void;
  isTTY?: boolean;
  now?: () => number;
  /** 启动 daemon;测试注入 stub,避免真的 spawn 子进程 */
  startDaemon?: (opts: StartDaemonOptions) => Promise<number>;
  /** 重启 daemon;测试注入 stub,避免真的 stop/start 子进程 */
  restartDaemon?: (opts: RestartDaemonOptions) => Promise<{ pid: number; wasRunning: boolean }>;
  /** 经验提取的提供方注入;测试传 mock,生产由 daemon/CLI 懒构造 */
  lessonDeps?: LessonProviderDeps;
}

function defaultCreateRemote(config: RemoteConfig): RemoteStore {
  return createRemoteFromConfig(config);
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
  opts: { library: { skills: number } | null },
): string[] {
  const lines = [pc.bold(`设备 ${r.deviceName} (${r.deviceId})`), '', pc.bold('本地')];
  if (r.harnesses.every((h) => h.sessionCount === 0)) lines.push('  (还没有归档数据)');
  for (const h of r.harnesses) {
    lines.push(
      `  ${h.displayName.padEnd(12)} ${pc.green(`${h.sessionCount} 个会话`)} · ${humanSize(h.bytes)}`,
    );
  }
  lines.push(
    '',
    pc.bold('技能'),
    opts.library
      ? `  ${pc.green(`${opts.library.skills} 个技能`)}`
      : '  尚未构建(跑一次 trove sync)',
  );
  return lines;
}

const LESSON_LABELS: Array<[Exclude<keyof LessonsSummary, 'total'>, string]> = [
  ['preferences', '偏好'],
  ['entities', '实体'],
  ['experiences', '经验'],
  ['events', '事件'],
  ['resources', '资源'],
];

function formatLessons(lessons: LessonsSummary, learnQueue: string[]): string[] {
  const lines = ['', pc.bold('学习沉淀')];
  if (lessons.total === 0) {
    lines.push('  暂无记忆(跑一次 trove learn)');
  } else {
    const parts = LESSON_LABELS.map(([k, label]) => `${label} ${lessons[k]}`).join(' · ');
    lines.push(`  ${pc.green(`${lessons.total} 条记忆`)} · ${parts}`);
  }
  lines.push(
    `  待学习 ${learnQueue.length > 0 ? pc.yellow(`${learnQueue.length} 个会话`) : '无'}`,
  );
  return lines;
}

function formatRemote(
  url: string,
  probe: RemoteStatus | null,
  selfId: string,
  now: number,
): string[] {
  const head = ['', pc.bold(`远端 ${url || '未配置'}`)];
  if (!probe) return [...head, '  未配置(先 trove init)'];
  if (!probe.ok) return [...head, `  ${pc.yellow('不可达')} · ${probe.error ?? ''}`.trimEnd()];

  const self = probe.devices.find((d) => d.id === selfId);
  const detail = [`可达`, `${probe.devices.length} 台设备`];
  if (self?.lastSeen) detail.push(`本机 ${humanSpan(now - self.lastSeen)}前在线`);
  const lines = [...head, `  ${pc.green(detail.join(' · '))}`];
  for (const d of probe.devices) {
    if (d.id === selfId) continue;
    const seen = d.lastSeen ? `${humanSpan(now - d.lastSeen)}前在线` : '在线时间未知';
    lines.push(`  ${d.name} (${d.id}) · ${seen}`);
  }
  return lines;
}

function formatDaemon(
  s: Awaited<ReturnType<typeof daemonState>>,
  now: number,
): string[] {
  const head = ['', pc.bold('daemon')];
  if (!s.running) return [...head, '  未运行 · 用 trove daemon start 启动'];
  const st = s.status;
  const lines = [
    ...head,
    `  ${pc.green('运行中')} (pid ${s.pid}) · 每 ${st?.intervalSeconds ?? '?'}s · 时间窗 ${st?.since ?? '?'}`,
  ];
  if (st?.lastRunAt) {
    lines.push(
      `  上次同步 ${humanSpan(now - st.lastRunAt)}前 · 耗时 ${((st.lastDurationMs ?? 0) / 1000).toFixed(1)}s` +
        (st.nextRunAt ? ` · 下次约 ${humanSpan(st.nextRunAt - now)}后` : ''),
    );
  }
  if (st?.lastResult) {
    const c = st.lastResult;
    lines.push(
      `  最近一轮 收集 ${c.collected.archived} · 拉取 ${c.pulled.downloadedItems} · ` +
        `推送 ${c.pushed.uploadedItems}`,
    );
  }
  if (st?.lastError) lines.push(pc.yellow(`  最近错误: ${st.lastError}`));
  return lines;
}

function formatPending(
  pending: StatusReport['pending'],
  library: Awaited<ReturnType<typeof computeLibraryPending>>,
  rawSync: boolean,
): string[] {
  const lines = ['', pc.bold('待同步')];
  const libFiles = library.sessions.files + library.skills.files + library.index.files;
  if (rawSync && pending.files === 0 && libFiles === 0) return [...lines, '  无'];

  if (!rawSync) lines.push('  raw 同步已关闭(仅同步 library)');
  else if (pending.files > 0) {
    lines.push(
      `  会话 ${pc.yellow(`${pending.sessions} 个`)} · ${pending.files} 个文件 · ${humanSize(pending.bytes)}`,
    );
    lines.push(
      `    ${pending.byHarness.map((h) => `${h.displayName} ${h.sessions}`).join(' · ')}`,
    );
  }

  if (library.sessions.files > 0) {
    lines.push(
      `  会话文件 ${library.sessions.count} 个会话 · ${library.sessions.files} 个文件 · ` +
        `${humanSize(library.sessions.bytes)}`,
    );
  }
  if (library.skills.files > 0) {
    lines.push(
      `  技能 ${pc.yellow(`${library.skills.count} 个`)} · ${library.skills.files} 个文件 · ` +
        `${humanSize(library.skills.bytes)}`,
    );
  }
  if (library.index.files > 0) {
    lines.push(`  索引 ${library.index.files} 个文件 · ${humanSize(library.index.bytes)}`);
  }
  return lines;
}

function looksLikeDateWindow(since: string): string {
  return since === 'all' ? 'all' : since;
}

async function loadRuntime(
  paths: ReturnType<typeof trovePaths>,
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
): Promise<{
  config: Config;
  remote: RemoteStore | null;
  adapters: Adapter[];
}> {
  const config = await loadConfig(paths.config);
  // 未配置远端时降级为本地模式,不报错
  const remote = isRemoteConfigured(config.remote) ? createRemote(config.remote) : null;
  return { config, remote, adapters: resolveAdapters(config) };
}

const ORPHAN_LABELS: Record<OrphanCategory, string> = {
  'raw-chunk': 'raw 旧分块',
  'raw-file': 'raw 整文件',
  'library-session': 'library 会话',
  'library-skill': 'library 技能',
};

function printOrphanScan(scan: OrphanScan, out: (l: string) => void): void {
  out(pc.cyan('待清理对象(只含 24 小时前的对象):'));
  const counts = new Map<OrphanCategory, { n: number; bytes: number }>();
  for (const o of scan.objects) {
    const c = counts.get(o.category) ?? { n: 0, bytes: 0 };
    c.n++;
    c.bytes += o.size;
    counts.set(o.category, c);
  }
  for (const cat of Object.keys(ORPHAN_LABELS) as OrphanCategory[]) {
    const c = counts.get(cat);
    if (c) out(`  ${ORPHAN_LABELS[cat]}  ${c.n} 个 (${humanSize(c.bytes)})`);
  }
  out(
    scan.objects.length
      ? `  合计 ${scan.objects.length} 个 (${humanSize(scan.bytes)})`
      : '  无',
  );
  if (scan.skippedDevices.length) {
    out(pc.yellow(`  跳过设备(索引缺失,一个都不删): ${scan.skippedDevices.join(', ')}`));
  }
  if (scan.librarySkipped) {
    out(pc.yellow('  library 分片不完整,本次跳过 library 清理'));
  }
  if (scan.skippedSkills.length) {
    out(pc.yellow(`  保留整个技能目录(meta 缺失): ${[...new Set(scan.skippedSkills)].join(', ')}`));
  }
}

async function cmdClean(
  opts: { dryRun?: boolean; yes?: boolean },
  paths: ReturnType<typeof trovePaths>,
  createRemote: (config: RemoteConfig) => RemoteStore,
  out: (l: string) => void,
  interactive: boolean,
): Promise<number> {
  const { remote } = await loadRuntime(paths, createRemote, () => []);
  if (!remote) {
    out('本地模式(未配置远端),没有可清理的对象');
    return 1;
  }
  const scan = await scanOrphans(remote);
  printOrphanScan(scan, out);
  if (scan.objects.length === 0) return 0;
  if (opts.dryRun) {
    out('dry-run:未删除任何对象');
    return 0;
  }

  let go = opts.yes === true;
  if (!go && interactive) {
    const ans = await confirm({
      message: `确认删除这 ${scan.objects.length} 个对象?`,
      initialValue: false,
    });
    go = ans === true;
  }
  if (!go) {
    out('未删除。确认无误后运行 `trove clean --yes`。');
    return 0;
  }

  const r = await deleteOrphans(remote, scan);
  out(`已删除 ${r.deleted} 个对象 (${humanSize(r.bytes)})${r.failed ? `, ${r.failed} 个失败` : ''}`);
  return 0;
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
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  out: (l: string) => void,
  rawOut: (s: string) => void,
  tty: boolean,
  interactive: boolean,
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
    remoteId: remoteIdentity(config.remote),
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
  if (!remote) out(pc.yellow('本地模式(未配置远端,仅本地 .trove 归档)'));
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

  // 切换远端后首次同步:询问是否清理旧对象,默认不清理
  if (report.remoteChanged && remote && interactive) {
    out(pc.yellow('检测到远端已切换。清理前建议其他设备停止同步。'));
    const yes = await confirm({
      message: '是否清理 24 小时前、且不再被索引引用的旧对象?',
      initialValue: false,
    });
    if (yes === true) {
      const scan = await scanOrphans(remote);
      printOrphanScan(scan, out);
      if (scan.objects.length > 0) {
        const r = await deleteOrphans(remote, scan);
        out(
          `已删除 ${r.deleted} 个对象 (${humanSize(r.bytes)})${r.failed ? `, ${r.failed} 个失败` : ''}`,
        );
      }
    } else {
      out('未清理。之后可运行 `trove clean` 查看。');
    }
  }
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

async function cmdLearnList(
  paths: ReturnType<typeof trovePaths>,
  sessionId: string | undefined,
  out: (l: string) => void,
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const diff = sessionId ? await readSessionDiff(storage, sessionId) : await readLatestDiff(storage);
  out(diff ? formatDiff(diff) : sessionId ? `无会话 ${sessionId} 的提取记录` : '尚无提取记录');
}

async function cmdLearnExtract(
  paths: ReturnType<typeof trovePaths>,
  sessionId: string,
  lessonDeps: LessonProviderDeps | undefined,
  out: (l: string) => void,
  force: boolean,
): Promise<void> {
  const outcome = await runLessonExtraction(
    paths.vault,
    sessionId,
    { ...lessonDeps, usagePath: paths.usageLog },
    { force },
  );
  if (outcome.skipReason === 'already_learned') {
    out('该会话已提取过,跳过(用 --force 强制重跑)');
    return;
  }
  if (outcome.skipReason) {
    out(`会话未达提取阈值,跳过: ${outcome.skipReason}`);
    return;
  }
  out(formatDiff(outcome.diff!));
}

async function cmdLearnMemo(
  paths: ReturnType<typeof trovePaths>,
  lessonDeps: LessonProviderDeps | undefined,
  out: (l: string) => void,
  force: boolean,
): Promise<void> {
  const adapter = createAdapters().find((a) => a.id === 'claude-code');
  if (!adapter || adapter.kind !== 'files') {
    out('未找到 claude-code 适配器,无法读取其记忆目录');
    return;
  }
  const config = await loadConfig(paths.config);
  const outcome = await learnClaudeMemo(paths.vault, adapter.source.root, { ...lessonDeps, config }, { force });
  if (outcome.skipReason === 'already_learned') {
    out('Claude Code 记忆已学习过,跳过(用 --force 强制重跑)');
    return;
  }
  if (outcome.skipReason) {
    out(`未学习到 Claude Code 记忆,跳过: ${outcome.skipReason}`);
    return;
  }
  out(formatDiff(outcome.diff!));
}

async function cmdLearnRecent(
  paths: ReturnType<typeof trovePaths>,
  lessonDeps: LessonProviderDeps | undefined,
  out: (l: string) => void,
  force: boolean,
): Promise<void> {
  const config = await loadConfig(paths.config);
  const outcome = await learnRecentMatters(paths.vault, { ...lessonDeps, config }, { force });
  if (outcome.skipReason === 'unchanged') {
    out('近期方向无变化,跳过(用 --force 强制重跑)');
    return;
  }
  if (outcome.skipReason) {
    out(`无近期会话可聚合,跳过: ${outcome.skipReason}`);
    return;
  }
  out(formatDiff(outcome.diff!));
}

async function cmdStatus(
  paths: ReturnType<typeof trovePaths>,
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  out: (l: string) => void,
  now: () => number,
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
  const rawSync = resolveRawSync(config);

  // 远端探测与本地统计并行;未配置就不发请求
  const probe = isRemoteConfigured(config.remote)
    ? probeRemote(createRemote(config.remote), AbortSignal.timeout(5000))
    : Promise.resolve(null);
  const [index, libraryPending, daemon, remote, lessons, learnQueue] = await Promise.all([
    loadLibraryIndex(paths.vault),
    computeLibraryPending(paths.vault, state),
    daemonState(paths),
    probe,
    computeLessonsSummary(paths.vault),
    readLearnQueue(paths.learnQueue),
  ]);

  const nowMs = now();
  out(
    [
      ...formatStatus(report, {
        library: index ? { skills: Object.keys(index.skills).length } : null,
      }),
...formatLessons(lessons, learnQueue),
      ...formatRemote(describeRemote(config.remote), remote, config.device.id, nowMs),
      ...formatDaemon(daemon, nowMs),
      ...formatPending(report.pending, libraryPending, rawSync),
    ].join('\n'),
  );
}

interface InitOptions {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  /** 远端类型:webdav / s3;不给则交互询问 */
  type?: 'webdav' | 's3';
  /** S3 厂商 */
  provider?: 'aliyun' | 'tencent';
  /** S3 地域 */
  region?: string;
  /** S3 Bucket */
  bucket?: string;
  /** 自定义 S3 endpoint(覆盖厂商推导;MinIO 等 S3 兼容私有部署需要) */
  endpoint?: string;
  /** path-style 寻址(bucket 放路径里);私有 S3 兼容服务通常需要 */
  forcePathStyle?: boolean;
  /** S3 AccessKey ID */
  accessKeyId?: string;
  /** S3 Secret AccessKey(也可用 TROVE_PASSWORD 环境变量) */
  secretAccessKey?: string;
  /** commander 的 --no-daemon 会传 false */
  daemon?: boolean;
}

function isCancel(v: unknown): v is symbol {
  return typeof v === 'symbol';
}

/**
 * 命令行给了足够的 S3 参数就直接用(供脚本化配置);否则返回 undefined 走交互引导。
 */
export function buildS3FromFlags(opts: InitOptions, existing: RemoteConfig): RemoteConfig | undefined {
  const prev = existing.type === 's3' ? existing : undefined;
  const bucket = opts.bucket ?? prev?.bucket;
  const region = opts.region ?? prev?.region;
  const accessKeyId = opts.accessKeyId ?? prev?.accessKeyId;
  const secretAccessKey =
    opts.secretAccessKey ?? process.env.TROVE_PASSWORD ?? prev?.secretAccessKey;
  const endpoint = opts.endpoint ?? prev?.endpoint;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return undefined;
  return {
    type: 's3',
    provider: opts.provider ?? prev?.provider ?? 'aliyun',
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? prev?.forcePathStyle ?? false,
  };
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

async function cmdConfig(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  err: (l: string) => void,
  interactive: boolean,
): Promise<number> {
  if (!interactive) {
    throw new Error('非交互环境无法交互式配置,请用 `trove config set <key> <value>`。');
  }
  const existing = await loadConfig(paths.config);

  const name = await text({ message: '设备名', initialValue: existing.device.name });
  if (isCancel(name)) {
    err('已取消。');
    return 1;
  }

  // 远端:先问类型,再按类型问字段
  const remote = await promptRemoteConfig(existing.remote, true);
  if (remote === undefined) {
    err('已取消。');
    return 1;
  }

  const config: Config = {
    ...existing,
    device: { ...existing.device, name: name as string },
    remote,
  };
  await saveConfig(paths.config, config);
  out(pc.green('配置已保存'));
  out(`  设备: ${config.device.name}`);
  out(`  远端: ${describeRemote(config.remote) || '未配置(本地模式)'}`);
  return 0;
}

async function cmdRename(
  name: string,
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('设备名不能为空');
  const existing = await loadConfig(paths.config);
  // 只改显示名;设备 id 保持稳定,已归档路径与远端索引不受影响
  await saveConfig(paths.config, { ...existing, device: { ...existing.device, name: trimmed } });
  out(pc.green(`设备已重命名为 ${trimmed} (id ${existing.device.id} 不变)`));
  out('  下次 trove sync 会把新名字写回远端设备 meta');
}

async function cmdInit(
  opts: InitOptions,
  paths: ReturnType<typeof trovePaths>,
  createRemote: (config: RemoteConfig) => RemoteStore,
  start: (opts: StartDaemonOptions) => Promise<number>,
  out: (l: string) => void,
  err: (l: string) => void,
  interactive: boolean,
): Promise<number> {
  const existing = await loadConfig(paths.config);
  const { name, url, username, password } = await resolveInitInputs(opts, interactive);
  if ([name, url, username, password].some(isCancel)) {
    err('已取消。');
    return 1;
  }

  // 远端配置:命令行 flag 优先,其次交互引导,都没有则进入本地模式
  let remoteConfig: RemoteConfig;
  let configuredThisRun = false;
  if (opts.type === 's3' || (opts.type === undefined && !url && interactive)) {
    // S3 路径:命令行给了完整参数就用参数,否则交互引导
    const fromFlags = buildS3FromFlags(opts, existing.remote);
    if (fromFlags) {
      remoteConfig = fromFlags;
    } else if (!interactive) {
      err('S3 参数不完整:需要 --bucket --region --access-key-id --secret-access-key(或 TROVE_PASSWORD)。');
      return 1;
    } else {
      const picked = await promptRemoteConfig(existing.remote, interactive, 's3');
      if (!picked) {
        err('已取消。');
        return 1;
      }
      remoteConfig = picked;
    }
    configuredThisRun = true;
  } else if (url) {
    // url 可选:不填则进入本地模式(仅本地 .trove 归档);填了就必须有密码
    if (!password) throw new Error('未提供密码(--password 或 TROVE_PASSWORD)。');
    remoteConfig = {
      type: 'webdav',
      url: url as string,
      username: username as string,
      password: password as string,
    };
    configuredThisRun = true;
  } else {
    // 本次 init 没给远端:进入本地模式(清掉旧远端)
    remoteConfig = { type: 'webdav', url: '', username: 'webdav', password: '' };
  }

  // 保留已有的 sources / sync / daemon 设置,只覆盖设备名与远端
  const config: Config = {
    ...existing,
    device: { id: existing.device.id, name: name as string },
    remote: remoteConfig,
  };

  if (isRemoteConfigured(remoteConfig)) {
    const remote = createRemote(remoteConfig);
    await mkdir(paths.tmp, { recursive: true });
    const probePath = `.trove-probe/${randomUUID()}.json`;
    const probeLocal = join(paths.tmp, `probe-${randomUUID()}.json`);
    await writeFile(probeLocal, '{"probe":true}\n');
    await remote.writeFile(probePath, probeLocal);
    const echoed = await remote.readJson(probePath);
    await remote.delete(probePath);
    await rm(probeLocal, { force: true });
    if (!echoed) throw new Error('连通性探针失败:写入的文件读不回来。');
  }

  await saveConfig(paths.config, config);
  out(pc.green('初始化完成'));
  out(`  设备: ${name as string} (${config.device.id})`);
  if (isRemoteConfigured(remoteConfig)) {
    out(`  远端: ${describeRemote(remoteConfig)}`);
  } else {
    out(`  远端: ${pc.yellow('未配置(本地模式,仅本地 .trove 归档)')}`);
  }

  if (opts.daemon === false || !config.daemon.startOnInit) return 0;
  try {
    const since = config.daemon.since;
    parseSince(since, Date.now()); // 配置可能被手改成非法值,启动前拦住
    const interval = Math.max(5, config.daemon.intervalSeconds);
    const pid = await start({
      paths,
      intervalSeconds: interval,
      since,
      env: { TROVE_HOME: paths.base },
    });
    out(`  daemon: 已启动 (pid ${pid}) · 每 ${interval}s · 时间窗 ${since} · 首轮同步进行中`);
  } catch (e) {
    const msg = (e as Error).message;
    out(msg.includes('已在运行') ? `  daemon: ${msg}` : pc.yellow(`  daemon: 启动失败 —— ${msg}`));
  }
  return 0;
}

function daemonRuntime(
  paths: ReturnType<typeof trovePaths>,
  opts: { interval: string; since: string; rawExplicit?: boolean },
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  now: () => number,
  lessonDeps: LessonProviderDeps | undefined,
  learnIntervalSeconds: number,
  learnBatch: number,
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
        remoteId: remoteIdentity(config.remote),
        cutoff: parseSince(opts.since, now()),
        progress,
        now,
        rawSync: resolveRawSync(config, opts.rawExplicit),
        signal,
      });
    },
    afterSync: async (report) => {
      const ids = report.collected.changedSessions;
      await enqueueLearn(paths.learnQueue, ids);
      return ids.length ? `经验提取入队 ${ids.length} 个新会话` : undefined;
    },
    learnTick: async () => {
      // 每 tick 重读配置,模型端点变更即时生效,无需重启 daemon。
      const config = await loadConfig(paths.config);
      const pending = await learnPendingBatch(paths.vault, paths.learnQueue, { ...lessonDeps, config, usagePath: paths.usageLog }, learnBatch, {
        log: (l) => void daemonLog(paths, l),
      });
      // 近期方向聚合:hash 不变则 skip(不烧 token),有实际更新才记一行,避免每 tick 刷噪音。
      const recent = await learnRecentMatters(paths.vault, { ...lessonDeps, config });
      const parts = [pending, recent.diff ? '近期方向已刷新' : undefined].filter((x): x is string => !!x);
      return parts.length ? parts.join(' · ') : undefined;
    },
    learnIntervalSeconds,
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
  const start = deps.startDaemon ?? startDaemon;
  const restart = deps.restartDaemon ?? restartDaemon;
  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const tty = deps.isTTY ?? Boolean(process.stdout.isTTY);

  const program = new Command();
  program
    .name('trove')
    .description('AI 会话资产归档与多设备同步')
    .version(VERSION);

  program
    .command('init')
    .description('首次配置(设备名、远端后端、凭证)')
    .option('--name <name>', '设备名')
    .option('--type <type>', '远端类型:webdav / s3(不给则交互询问)')
    .option('--url <url>', 'WebDAV 地址')
    .option('--username <user>', 'WebDAV 用户名')
    .option('--password <pass>', 'WebDAV 密码(也可用 TROVE_PASSWORD 环境变量)')
    .option('--provider <vendor>', 'S3 厂商:aliyun / tencent')
    .option('--region <region>', 'S3 地域(如 cn-hangzhou / ap-guangzhou)')
    .option('--bucket <bucket>', 'S3 Bucket 名')
    .option('--endpoint <url>', '自定义 S3 endpoint(覆盖厂商推导,MinIO 等私有部署用)')
    .option('--force-path-style', 'S3 用 path-style 寻址(bucket 放路径里,私有部署常用)')
    .option('--access-key-id <id>', 'S3 AccessKey ID')
    .option('--secret-access-key <key>', 'S3 Secret AccessKey(也可用 TROVE_PASSWORD 环境变量)')
    .option('--no-daemon', '初始化后不自动启动 daemon')
    .action(async (opts: InitOptions) => {
      const code = await cmdInit(opts, paths, createRemote, start, out, err, interactive);
      if (code !== 0) process.exitCode = code;
    });

  program
    .command('rename <name>')
    .description('重命名当前设备(只改显示名,设备 id 与已归档路径不变)')
    .action(async (name: string) => {
      await cmdRename(name, paths, out);
    });

  const configCmd = program.command('config').description('交互式配置(子命令:path/get/set)');
  configCmd.action(async () => {
    const code = await cmdConfig(paths, out, err, interactive);
    if (code !== 0) process.exitCode = code;
  });
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
          interactive,
          now,
        );
      },
    );

  program
    .command('clean')
    .description('清理远端中不再被索引引用的旧对象 (默认只列出)')
    .option('--dry-run', '只列出,不删除')
    .option('--yes', '不再确认,直接删除')
    .action(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      const code = await cmdClean(opts, paths, createRemote, out, interactive);
      if (code !== 0) process.exitCode = code;
    });

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
    .command('learn')
    .description('经验提取与审计查看')
    .argument('[sessionId]', '对单会话跑提取流水线(缺省需配合 --list)')
    .option('--list', '查看最近一次提取的审计 diff')
    .option('--session <id>', '配合 --list 指定会话')
    .option('--force', '即使已提取过也强制重跑')
    .option('-n, --recent <n>', '按最近优先提取 n 个未学习会话')
    .action(
      async (sessionId: string | undefined, opts: { list?: boolean; session?: string; force?: boolean; recent?: string }) => {
        if (opts.list) {
          await cmdLearnList(paths, opts.session, out);
        } else if (opts.recent !== undefined) {
          const n = Number(opts.recent);
          if (!Number.isInteger(n) || n <= 0) {
            err('用法: trove learn -n <正整数>');
            return;
          }
          const config = await loadConfig(paths.config);
          out(`准备提取最近 ${n} 个未学习会话...`);
          const summary = await learnRecentBatch(paths.vault, n, { ...deps.lessonDeps, config }, { log: (l) => out(l) });
          out(pc.green(summary));
        } else if (sessionId) {
          const config = await loadConfig(paths.config);
          await cmdLearnExtract(paths, sessionId, { ...deps.lessonDeps, config }, out, opts.force === true);
        } else {
          err('用法: trove learn <session-id> | trove learn -n <数量> | trove learn --list [--session <id>]');
        }
      },
    );

  program
    .command('learn-memo')
    .description('学习 Claude Code 自带记忆系统(~/.claude/projects/*/memory)进入 lessons')
    .option('--force', '即使已学习过也强制重跑')
    .action(async (opts: { force?: boolean }) => {
      await cmdLearnMemo(paths, deps.lessonDeps, out, opts.force === true);
    });

  program
    .command('learn-recent')
    .description('从最近会话聚合用户近期工作方向(时间+项目+主题)写入 recent_matters')
    .option('--force', '即使输入无变化也强制重跑')
    .action(async (opts: { force?: boolean }) => {
      await cmdLearnRecent(paths, deps.lessonDeps, out, opts.force === true);
    });

  program
    .command('usage')
    .description('查看 trove 自身消耗的 LLM token 用量(learn 与 daemon 定时任务)')
    .option('--since <range>', '时间范围(如 7d / 24h / 2026-10-01 / all)', 'all')
    .option('--json', '输出 JSON')
    .action(async (opts: { since?: string; json?: boolean }) => {
      const since = opts.since ?? 'all';
      const cutoff = parseSince(since, now()); // 非法值抛错,由 run 统一报错退出
      const records = await readUsageRecords(paths.usageLog);
      const filtered = cutoff ? records.filter((r) => Date.parse(r.at) >= cutoff) : records;
      const summary = summarizeUsage(filtered);
      if (opts.json) {
        out(JSON.stringify({ since, ...summary }, null, 2));
        return;
      }
      out(formatUsageSummary(summary, since).join('\n'));
    });

  program
    .command('refresh')
    .description('强制重建 lessons 分层概览(index/.abstract.md/.overview.md)')
    .action(async () => {
      const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
      const written = await refreshSidecars(storage, { trigger: 'manual_refresh', now: () => new Date(now()) });
      out(pc.green(`已重建 ${written.length} 个分层概览文件`));
    });

  program
    .command('status')
    .description('概览(本地归档、远端、daemon、待同步)')
    .action(async () => {
      await cmdStatus(paths, createRemote, resolveAdapters, out, now);
    });

  const daemonCmd = program.command('daemon').description('常驻后台同步服务');

  /** start/restart 共用:解析 interval/since/raw,CLI 显式参数优先于 config。 */
  async function daemonStartOptions(
    cmd: Command,
    opts: { interval?: string; since?: string; raw?: boolean },
  ): Promise<StartDaemonOptions> {
    const config = await loadConfig(paths.config);
    const since = opts.since ?? config.daemon.since;
    parseSince(since, now()); // 启动前校验,避免子进程每轮都失败
    const interval = Math.max(5, Number(opts.interval ?? config.daemon.intervalSeconds) || 300);
    const rawExplicit =
      cmd.getOptionValueSource('raw') === 'cli' ? opts.raw === true : undefined;
    return { paths, intervalSeconds: interval, since, raw: rawExplicit };
  }

  daemonCmd
    .command('start')
    .description('后台启动 daemon')
    .option('--interval <seconds>', '轮询间隔秒数(默认取 config.daemon.intervalSeconds)')
    .option('--since <range>', '只收集最近变更的会话(默认取 config.daemon.since)')
    .option('--raw', '同步 raw(覆盖配置)')
    .option('--no-raw', '只同步 library(raw 只归档到本地)')
    .action(async function (this: Command, opts: { interval?: string; since?: string; raw?: boolean }) {
      const startOpts = await daemonStartOptions(this, opts);
      const pid = await start(startOpts);
      out(
        pc.green(
          `daemon 已启动 (pid ${pid}) · 每 ${startOpts.intervalSeconds}s · ` +
            `时间窗 ${looksLikeDateWindow(startOpts.since)}`,
        ),
      );
    });

  daemonCmd
    .command('restart')
    .description('重启 daemon(停止后按同样参数重新拉起)')
    .option('--interval <seconds>', '轮询间隔秒数(默认取 config.daemon.intervalSeconds)')
    .option('--since <range>', '只收集最近变更的会话(默认取 config.daemon.since)')
    .option('--raw', '同步 raw(覆盖配置)')
    .option('--no-raw', '只同步 library(raw 只归档到本地)')
    .action(async function (this: Command, opts: { interval?: string; since?: string; raw?: boolean }) {
      const startOpts = await daemonStartOptions(this, opts);
      const { pid, wasRunning } = await restart(startOpts);
      out(
        pc.green(
          `daemon 已重启 (pid ${pid}) · 每 ${startOpts.intervalSeconds}s · ` +
            `时间窗 ${looksLikeDateWindow(startOpts.since)}`,
        ),
      );
      if (!wasRunning) out(pc.yellow('  原 daemon 未在运行,已直接启动'));
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
      const config = await loadConfig(paths.config);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      const rawExplicit =
        this.getOptionValueSource('raw') === 'cli' ? opts.raw === true : undefined;
      await runDaemon(
        daemonRuntime(
          paths,
          { ...opts, rawExplicit },
          createRemote,
          resolveAdapters,
          now,
          deps.lessonDeps,
          config.daemon.learnIntervalSeconds,
          config.daemon.learnBatch,
        ),
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

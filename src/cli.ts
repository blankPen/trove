import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command, CommanderError } from 'commander';
import { confirm, select, text } from '@clack/prompts';
import pc from 'picocolors';
import { trovePaths, type TrovePaths } from './paths.js';
import { loadConfig, resolveRawSync, saveConfig, type Config, type RemoteConfig } from './config.js';
import { loadState } from './core/state.js';
import { sync } from './core/sync.js';
import { deleteOrphans, scanOrphans, type OrphanCategory, type OrphanScan } from './core/clean.js';
import { listSessions } from './core/sessions.js';
import { formatWhoami, readWhoami, type WhoamiSection } from './core/whoami.js';
import {
  buildSearchIndex,
  getLesson,
  getSearchStatus,
  getSession,
  listLessons,
  searchLessons,
  searchSessions,
} from './core/search/service.js';
import {
  formatLesson,
  formatLessonHits,
  formatSession,
  formatSessionHits,
} from './core/search/format.js';
import { installSkill, uninstallSkill, type SkillTarget } from './skill/install.js';
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
import { defaultResolveAdapters, loadRuntime } from './runtime.js';
import { startServer } from './server/index.js';
import { createConsoleProgress } from './progress-console.js';
import { silentProgress } from './progress.js';
import { formatDiff, readLatestDiff, readSessionDiff, readShadowDiff } from './core/lessons/audit.js';
import { LocalStorageAdapter } from './core/lessons/storage.js';
import { refreshSidecars } from './core/lessons/sidecar.js';
import { runLessonExtraction, learnPendingBatch, learnRecentBatch, resolveProviders, migrateJsonQueue, enqueueLearnSessions } from './core/lessons/learn.js';
import type { LessonProviderDeps } from './core/lessons/learn.js';
import { JobQueue } from './core/lessons/jobs.js';
import { qmdIndexStatus, syncQmdIndex } from './core/search/qmd.js';
import type { QmdSearchConfig } from './core/search/qmd.js';
import { formatUsageSummary, readUsageRecords, summarizeUsage } from './core/lessons/usage.js';
import { learnClaudeMemo } from './core/lessons/memo.js';
import { learnRecentMatters } from './core/lessons/recent.js';
import { readLearnQueue } from './core/lessons/queue.js';
import { planMigration, applyMigration, rollbackMigration } from './core/lessons/migrate.js';
import { readLearnConfig } from './core/lessons/config.js';
import { JevDecisionGateway } from './core/lessons/gateway.js';
import {
  acceptInboxItem,
  listInbox,
  readInboxItem,
  rejectInboxItem,
  updateInboxItem,
} from './core/lessons/inbox.js';
import type { InboxItem } from './core/lessons/inbox.js';
import { readTrust, writeTrust } from './core/lessons/trust.js';
import type { TrustLevel } from './core/lessons/trust.js';
import { readDecisions } from './core/lessons/decisions.js';
import { parseMemory } from './core/lessons/memory.js';
import { countStaleMemories, maybeRunCurator, runCurator } from './core/lessons/curator.js';
import { forgetMemory, restoreMemory, setPinned } from './core/lessons/control.js';
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

// 版本号跟 package.json 走:发版只改 package.json,不用再手动同步这里
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

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

function formatLessons(lessons: LessonsSummary, learnPending: number): string[] {
  const lines = ['', pc.bold('学习沉淀')];
  if (lessons.total === 0) {
    lines.push('  暂无记忆(跑一次 trove learn)');
  } else {
    const parts = LESSON_LABELS.map(([k, label]) => `${label} ${lessons[k]}`).join(' · ');
    lines.push(`  ${pc.green(`${lessons.total} 条记忆`)} · ${parts}`);
  }
  lines.push(
    `  待学习 ${learnPending > 0 ? pc.yellow(`${learnPending} 个会话`) : '无'}`,
  );
  return lines;
}

/** 待学习数:DB queued+retryWait,加旧 JSON 队列尚未迁移的待办。 */
async function pendingLearnCount(paths: ReturnType<typeof trovePaths>): Promise<number> {
  const queue = JobQueue.open(paths.learnDb);
  try {
    const s = queue.stats();
    const legacy = await readLearnQueue(paths.learnQueue);
    return s.queued + s.retryWait + legacy.length;
  } finally {
    queue.close();
  }
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

async function cmdWhoami(
  opts: { sections?: string; full?: boolean; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const sections = (opts.sections ?? 'profile,styles,recent')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as WhoamiSection[];
  const result = await readWhoami(paths.vault, { sections, full: opts.full === true });
  out(opts.json ? JSON.stringify(result, null, 2) : formatWhoami(result));
}

/** 从 learn.search 映射检索后端配置;配置不可读/关闭时返回 undefined(纯 FTS)。 */
async function searchBackendConfig(paths: ReturnType<typeof trovePaths>): Promise<QmdSearchConfig | undefined> {
  try {
    const learn = readLearnConfig(await loadConfig(paths.config));
    if (!learn.search.enabled) return undefined;
    return {
      dbPath: paths.qmdDb,
      model: learn.search.model,
      host: learn.search.host,
      minScore: learn.search.minScore,
    };
  } catch {
    return undefined;
  }
}

/** 生产学习写盘后的检索索引增量同步;任何失败静默(索引是可选增强,不阻断学习)。 */
async function syncSearchIndex(paths: ReturnType<typeof trovePaths>): Promise<void> {
  try {
    const backend = await searchBackendConfig(paths);
    if (!backend) return;
    await syncQmdIndex(paths.vault, backend);
  } catch {
    // 索引同步失败不阻断学习
  }
}

/** 测试注入 lessonDeps 时不自动接索引同步(防联网/防加载模型);生产(undefined)才接。 */
function withIndexSync(
  lessonDeps: LessonProviderDeps | undefined,
  paths: ReturnType<typeof trovePaths>,
): LessonProviderDeps {
  if (lessonDeps) return lessonDeps;
  return { syncIndex: () => syncSearchIndex(paths) };
}

async function cmdLessonsSearch(
  query: string,
  opts: { category?: string; type?: string; since?: string; limit?: string; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  nowMs: number,
): Promise<void> {
  const since = opts.since ? (parseSince(opts.since, nowMs) ?? undefined) : undefined;
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const backend = await searchBackendConfig(paths);
  const hits = await searchLessons(
    paths.vault,
    {
      query,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(since ? { since } : {}),
      limit,
      cwd: process.cwd(),
    },
    backend,
  );
  out(
    opts.json
      ? JSON.stringify({ query, total: hits.length, results: hits }, null, 2)
      : formatLessonHits(hits),
  );
}

async function cmdLessonShow(
  rel: string,
  opts: { section?: string; lines?: string; full?: boolean; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const doc = await getLesson(paths.vault, rel, {
    ...(opts.section ? { section: opts.section } : {}),
    ...(opts.lines ? { lines: opts.lines } : {}),
    ...(opts.full !== undefined ? { full: opts.full } : {}),
  });
  if (!doc) {
    out(`没有找到 lesson: ${rel}`);
    return;
  }
  out(opts.json ? JSON.stringify(doc, null, 2) : formatLesson(doc));
}

async function cmdLessonsList(
  opts: { category?: string; since?: string; limit?: string; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  nowMs: number,
): Promise<void> {
  const since = opts.since ? (parseSince(opts.since, nowMs) ?? undefined) : undefined;
  const hits = await listLessons(paths.vault, {
    ...(opts.category ? { category: opts.category } : {}),
    ...(since ? { since } : {}),
    limit: Math.max(1, Math.min(100, Number(opts.limit) || 50)),
  });
  out(opts.json ? JSON.stringify({ total: hits.length, results: hits }, null, 2) : formatLessonHits(hits));
}

/** pin/unpin:按 id 或路径设置/清除 pinned。 */
async function cmdLessonPin(
  ref: string,
  pinned: boolean,
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const found = await setPinned(storage, ref, pinned);
  if (!found) {
    out(`没有找到记忆: ${ref}`);
    return;
  }
  out(pinned ? `已固定: ${found.path}` : `已取消固定: ${found.path}`);
}

/** forget:移到 .trove/forgotten/<ISO>/,内容保留,可 restore 找回。 */
async function cmdLessonForget(
  ref: string,
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const res = await forgetMemory(storage, ref);
  if (!res) {
    out(`没有找到记忆: ${ref}`);
    return;
  }
  out(`已忘掉（可恢复）: ${res.path} → ${res.target}`);
}

/** restore:从 archive/(或 --from 目录)移回原路径。 */
async function cmdLessonRestore(
  ref: string,
  from: string | undefined,
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const res = await restoreMemory(storage, ref, from ? { from } : {});
  if (!res) {
    out(`没有找到可恢复的记忆: ${ref}`);
    return;
  }
  out(`已恢复: ${res.path}`);
}

async function cmdSessionsSearch(
  query: string,
  opts: { harness?: string; device?: string; since?: string; limit?: string; exact?: boolean; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  nowMs: number,
): Promise<void> {
  const since = opts.since ? (parseSince(opts.since, nowMs) ?? undefined) : undefined;
  const res = await searchSessions(paths.vault, paths.cache, {
    query,
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.device ? { device: opts.device } : {}),
    ...(since ? { since } : {}),
    limit: Math.max(1, Math.min(50, Number(opts.limit) || 10)),
    ...(opts.exact !== undefined ? { exact: opts.exact } : {}),
    cwd: process.cwd(),
  });
  out(
    opts.json
      ? JSON.stringify({ query, ...res }, null, 2)
      : formatSessionHits(res.results, {
          ...(res.stale ? { stale: true } : {}),
          ...(res.degraded ? { degraded: res.degraded } : {}),
        }),
  );
}

async function cmdSessionShow(
  id: string,
  opts: { harness?: string; around?: string; limit?: string; json?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const detail = await getSession(paths.vault, paths.cache, id, {
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.around ? { around: opts.around } : {}),
    limit: Math.max(1, Math.min(50, Number(opts.limit) || 20)),
  });
  if (!detail) {
    out(`没有找到会话: ${id}`);
    return;
  }
  out(opts.json ? JSON.stringify(detail, null, 2) : formatSession(detail));
}

async function cmdIndexBuild(
  opts: { force?: boolean; since?: string; quiet?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  nowMs: number,
): Promise<void> {
  const since = opts.since ? (parseSince(opts.since, nowMs) ?? undefined) : undefined;
  const stats = await buildSearchIndex(paths.vault, paths.cache, {
    ...(opts.force ? { force: true } : {}),
    ...(since ? { since } : {}),
  });
  if (!opts.quiet) {
    out(
      pc.green(
        `索引完成: 扫描 ${stats.scanned} · 更新 ${stats.changed} · 删除 ${stats.removed} · ` +
          `耗时 ${stats.tookMs}ms · ${humanSize(stats.sizeBytes)}`,
      ),
    );
  }
}

async function cmdStatusJson(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const config = await loadConfig(paths.config);
  const [index, daemon, search] = await Promise.all([
    loadLibraryIndex(paths.vault),
    daemonState(paths),
    getSearchStatus(paths.vault, paths.cache),
  ]);
  out(
    JSON.stringify(
      {
        device: { id: config.device.id, name: config.device.name },
        sessions: { total: index ? Object.keys(index.sessions).length : 0 },
        skills: { total: index ? Object.keys(index.skills).length : 0 },
        daemon: {
          running: daemon.running,
          lastRunAt: daemon.status?.lastRunAt ?? null,
          lastError: daemon.status?.lastError ?? null,
        },
        search,
      },
      null,
      2,
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
  const diff = sessionId
    ? (await readSessionDiff(storage, sessionId)) ?? (await readShadowDiff(storage, sessionId))
    : await readLatestDiff(storage);
  out(diff ? formatDiff(diff) : sessionId ? `无会话 ${sessionId} 的提取记录` : '尚无提取记录');
}

async function cmdLearnMigrate(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  opts: { apply?: boolean; rollback?: string },
): Promise<void> {
  if (opts.rollback) {
    const n = await rollbackMigration(paths.vault, opts.rollback);
    out(`已回滚 ${n} 条记忆`);
    return;
  }
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const plan = await planMigration(storage);
  if (opts.apply) {
    const r = await applyMigration(storage, plan, { vaultRoot: paths.vault });
    out(`已迁移 ${r.migrated} 条记忆(已 v2 ${r.alreadyV2} 条跳过),备份目录: ${r.backupDir}`);
    return;
  }
  out(`待迁移 ${plan.items.length} 条、已 v2 ${plan.alreadyV2} 条、跳过(非记忆) ${plan.skipped.length} 条`);
  for (const p of plan.skipped.slice(0, 5)) out(`  跳过: ${p}`);
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
    { ...lessonDeps, usagePath: paths.usageLog, onStage: (l) => out(l) },
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

function formatInboxLine(it: InboxItem): string {
  const q = it.quality
    ? ` · 质量 ${it.quality.specific}/${it.quality.actionable}/${it.quality.transferable}/${it.quality.evidence}/${it.quality.non_duplicate}`
    : '';
  const ev = it.evidence[0]?.quote ? ` · 「${it.evidence[0].quote.slice(0, 60)}」` : '';
  return `${it.id} · ${it.type} · ${it.title}${q} · ${it.session}${ev}`;
}

async function printTrust(storage: LocalStorageAdapter, out: (l: string) => void): Promise<void> {
  const t = await readTrust(storage);
  out(`信任等级 L${t.level} · 接受 ${t.accepted} · 拒绝 ${t.rejected} · 起始 ${t.since}`);
}

/** 用 $EDITOR(无则 vi)编辑正文,返回「是否接受」;取消编辑保持原样返回 false。 */
async function editInboxItem(storage: LocalStorageAdapter, it: InboxItem, out: (l: string) => void): Promise<boolean> {
  const tmp = join(tmpdir(), `trove-inbox-${it.id}.md`);
  await writeFile(tmp, it.content, 'utf8');
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const r = spawnSync(editor, [tmp], { stdio: 'inherit' });
  const edited = await readFile(tmp, 'utf8').catch(() => it.content);
  await rm(tmp, { force: true }).catch(() => {});
  if (r.error || edited === it.content) return false;
  await updateInboxItem(storage, it.id, { content: edited });
  out('正文已更新,重新确认:');
  const ok = await select({
    message: '编辑后是否接受?',
    options: [
      { value: 'accept', label: 'accept 接受' },
      { value: 'reject', label: 'reject 拒绝' },
    ],
  });
  return ok === 'accept';
}

async function cmdLearnReview(
  paths: ReturnType<typeof trovePaths>,
  lessonDeps: LessonProviderDeps | undefined,
  out: (l: string) => void,
  interactive: boolean,
  opts: { acceptAll?: boolean; rejectAll?: boolean; session?: string; json?: boolean },
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const config = lessonDeps?.config ?? (await loadConfig(paths.config));
  const learn = readLearnConfig(config);
  const items = await listInbox(storage, opts.session ? { session: opts.session } : undefined);

  if (opts.json) {
    out(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    out('暂无待审候选(inbox 为空)');
    return;
  }

  const { llm, jev } = resolveProviders({ ...lessonDeps, config });
  const gateway = new JevDecisionGateway({ jev, learn, llm });

  if (opts.acceptAll) {
    for (const it of items) {
      const r = await acceptInboxItem(storage, it.id, { gateway, llm, learn, afterWrite: lessonDeps?.syncIndex });
      out(`已接受: ${it.title}${r.paths.length ? ` → ${r.paths.join(', ')}` : '(重复,未新增)'}`);
    }
    await printTrust(storage, out);
    return;
  }
  if (opts.rejectAll) {
    for (const it of items) {
      await rejectInboxItem(storage, it.id);
      out(`已拒绝: ${it.title}`);
    }
    await printTrust(storage, out);
    return;
  }

  if (!interactive) {
    out(`待审 ${items.length} 条,前 ${Math.min(5, items.length)} 条摘要:`);
    for (const it of items.slice(0, 5)) out(`  ${formatInboxLine(it)}`);
    out('用 trove learn review 交互处理,或 --accept-all / --reject-all 批量处理');
    return;
  }

  for (const it of items) {
    out(formatInboxLine(it));
    const action = await select({
      message: `${it.type} · ${it.title}`,
      options: [
        { value: 'accept', label: 'accept 接受' },
        { value: 'edit', label: 'edit 编辑' },
        { value: 'reject', label: 'reject 拒绝' },
        { value: 'skip', label: 'skip 跳过' },
        { value: 'quit', label: 'quit 退出' },
      ],
    });
    if (isCancel(action) || action === 'quit') break;
    if (action === 'accept') {
      const r = await acceptInboxItem(storage, it.id, { gateway, llm, learn, afterWrite: lessonDeps?.syncIndex });
      out(`已接受: ${it.title}${r.paths.length ? ` → ${r.paths.join(', ')}` : '(重复,未新增)'}`);
    } else if (action === 'reject') {
      await rejectInboxItem(storage, it.id);
      out(`已拒绝: ${it.title}`);
    } else if (action === 'edit') {
      if (await editInboxItem(storage, it, out)) {
        const r = await acceptInboxItem(storage, it.id, { gateway, llm, learn, afterWrite: lessonDeps?.syncIndex });
        out(`已接受: ${it.title}${r.paths.length ? ` → ${r.paths.join(', ')}` : '(重复,未新增)'}`);
      }
    }
    // skip: 不处理,继续下一条
  }
  await printTrust(storage, out);
}

async function cmdLearnWhy(
  paths: ReturnType<typeof trovePaths>,
  id: string | undefined,
  out: (l: string) => void,
): Promise<void> {
  if (!id) {
    out('用法: trove learn why <inbox-id | memory-id | session-id>');
    return;
  }
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));

  const item = await readInboxItem(storage, id);
  if (item) {
    out(`inbox 候选: ${item.id}`);
    out(`类型: ${item.type} · 标题: ${item.title} · 会话: ${item.session}`);
    if (item.quality) {
      out(`质量: specific=${item.quality.specific} actionable=${item.quality.actionable} transferable=${item.quality.transferable} evidence=${item.quality.evidence} non_duplicate=${item.quality.non_duplicate}`);
    }
    for (const e of item.evidence) out(`证据: ${e.quote}${e.path ? ` (${e.path}:${e.line ?? '-'})` : ''}`);
    out(`正文:\n${item.content}`);
    return;
  }

  for (const f of await storage.list()) {
    if (f.split('/').some((seg) => seg.startsWith('.'))) continue;
    const text = await storage.read(f);
    if (text === null) continue;
    const mem = parseMemory(text);
    if (!mem || mem.id !== id) continue;
    out(`记忆: ${f} · status=${mem.status} · version=${mem.version} · promptVersion=${mem.promptVersion ?? '-'}`);
    if (mem.quality) {
      out(`质量: specific=${mem.quality.specific} actionable=${mem.quality.actionable} transferable=${mem.quality.transferable} evidence=${mem.quality.evidence} non_duplicate=${mem.quality.non_duplicate}`);
    }
    for (const e of mem.evidence) out(`证据: ${e.quote}${e.path ? ` (${e.path}:${e.line ?? '-'})` : ''}`);
    const session = mem.evidence[0]?.session;
    if (session) {
      const decisions = await readDecisions(storage, { session });
      if (decisions.length) {
        out(`会话 ${session} 的决策记录:`);
        for (const d of decisions) out(`  [${d.at}] ${d.stage} ${d.decision} (${d.source})`);
      }
    }
    return;
  }

  const decisions = await readDecisions(storage, { session: id });
  if (decisions.length) {
    out(`会话 ${id} 的决策记录:`);
    for (const d of decisions) out(`[${d.at}] ${d.stage} ${d.decision} (${d.source})`);
    return;
  }
  out(`找不到 ${id}(既不是 inbox id、记忆 id,也不是会话 id)`);
}

async function cmdLearnTrust(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  level: string | undefined,
): Promise<void> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  if (level === undefined) {
    await printTrust(storage, out);
    return;
  }
  const n = Number(level);
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    out('用法: trove learn trust --level <0-3>');
    return;
  }
  const cur = await readTrust(storage);
  await writeTrust(storage, { ...cur, level: n as TrustLevel, updatedAt: new Date().toISOString() });
  out(`信任等级已设为 L${n}(仅人为设置)`);
}

async function cmdLearnStatus(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  json: boolean,
): Promise<void> {
  const queue = JobQueue.open(paths.learnDb);
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const config = await loadConfig(paths.config);
  const learn = readLearnConfig(config);
  const backend = await searchBackendConfig(paths);
  const indexStatus = backend ? await qmdIndexStatus(paths.vault, backend) : null;
  try {
    const s = queue.stats();
    const dead = queue.listDead(5);
    const inbox = await listInbox(storage);
    const trust = await readTrust(storage);
    const staleMemories = await countStaleMemories(storage);
    if (json) {
      out(
        JSON.stringify(
          {
            queue: s,
            recentFailures: dead.map((j) => ({ id: j.id, sessionKey: j.sessionKey, error: j.lastError, errorClass: j.errorClass, attempts: j.attempts })),
            inboxPending: inbox.length,
            trust: trust.level,
            staleMemories,
            searchIndex: indexStatus?.documents ?? 0,
            searchIndexPendingEmbed: indexStatus?.needsEmbedding ?? 0,
            searchModel: learn.search.enabled ? learn.search.model : null,
          },
          null,
          2,
        ),
      );
      return;
    }
    out(
      [
        `队列: 待处理 ${s.queued} · 重试等待 ${s.retryWait} · 运行中 ${s.running} · 完成 ${s.done} · 跳过 ${s.skipped} · 死信 ${s.dead}`,
        `最老排队: ${s.oldestQueuedAt ? `${humanSpan(Date.now() - s.oldestQueuedAt)}前` : '-'} · p50 ${s.p50Ms ?? '-'}ms · p95 ${s.p95Ms ?? '-'}ms`,
        `inbox 待审 ${inbox.length} · 信任等级 L${trust.level} · stale 记忆 ${staleMemories}`,
        `检索索引 ${indexStatus?.documents ?? 0} 篇（待嵌入 ${indexStatus?.needsEmbedding ?? 0}）· 模型 ${learn.search.enabled ? learn.search.model : '-'}`,
      ].join('\n'),
    );
    for (const j of dead) out(`  失败: ${j.sessionKey} · ${j.errorClass ?? '-'} · ${j.lastError}`);
  } finally {
    queue.close();
  }
}

/** curator:跑一轮记忆生命周期维护(过期 → stale → 归档,复活最近用过的)。 */
async function cmdLearnCurator(
  opts: { dryRun?: boolean },
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
): Promise<void> {
  const config = await loadConfig(paths.config);
  const learn = readLearnConfig(config);
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const report = await runCurator(storage, {
    staleDays: learn.lifecycle.staleDays,
    archiveDays: learn.lifecycle.archiveDays,
    trajectoryDays: learn.lifecycle.trajectoryDays,
    trajectoryMax: learn.lifecycle.trajectoryMax,
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  out(
    `curator${opts.dryRun ? '(dry-run)' : ''}: stale ${report.stale.length} · 归档 ${report.archived.length} · 复活 ${report.revived.length} · 使用更新 ${report.usageUpdated.length}`,
  );
  for (const p of report.stale.slice(0, 5)) out(`  stale: ${p}`);
  for (const p of report.archived.slice(0, 5)) out(`  归档: ${p}`);
  for (const p of report.revived.slice(0, 5)) out(`  复活: ${p}`);
  for (const p of report.usageUpdated.slice(0, 5)) out(`  使用更新: ${p}`);
}

async function cmdLearnPause(
  paths: ReturnType<typeof trovePaths>,
  out: (l: string) => void,
  paused: boolean,
): Promise<void> {
  const config = await loadConfig(paths.config);
  config.learn.paused = paused;
  await saveConfig(paths.config, config);
  out(paused ? 'learn 已暂停(learn.paused=true)' : 'learn 已恢复(learn.paused=false)');
}

async function cmdLearnRetry(
  paths: ReturnType<typeof trovePaths>,
  jobId: string | undefined,
  out: (l: string) => void,
): Promise<void> {
  if (!jobId) {
    out('用法: trove learn retry <job-id>');
    return;
  }
  const queue = JobQueue.open(paths.learnDb);
  try {
    const job = queue.get(jobId);
    if (!job) {
      out(`没有找到作业: ${jobId}`);
      return;
    }
    if (job.state !== 'dead') {
      out(`作业 ${jobId} 当前状态 ${job.state},无需重试(仅 dead 可重试)`);
      return;
    }
    queue.retry(jobId);
    out(`作业 ${jobId} 已重新入队`);
  } finally {
    queue.close();
  }
}

async function cmdDoctor(paths: ReturnType<typeof trovePaths>, out: (l: string) => void): Promise<void> {
  const results: Array<[string, boolean]> = [];
  const push = (label: string, ok: boolean): void => void results.push([label, ok]);

  let config: Config | null = null;
  try {
    config = await loadConfig(paths.config);
    push('config.json 可读', true);
  } catch (e) {
    push(`config.json 可读 —— ${(e as Error).message}`, false);
  }
  push('LLM 配置齐全', !!(config?.llm?.baseUrl && config.llm.model && config.llm.apiKey));
  push('Jev 配置齐全', !!(config?.jev?.apiKey && config.jev.model));

  try {
    const queue = JobQueue.open(paths.learnDb);
    const s = queue.stats();
    queue.close();
    push(`learn.db 可打开(待处理 ${s.queued + s.retryWait} · 死信 ${s.dead})`, true);
  } catch (e) {
    push(`learn.db 可打开 —— ${(e as Error).message}`, false);
  }

  const backend = await searchBackendConfig(paths);
  if (!backend) {
    push('检索后端已关闭(learn.search.enabled=false),纯 FTS 可用', true);
  } else {
    const status = await qmdIndexStatus(paths.vault, backend);
    if (!status || status.documents === 0) {
      push('qmd 检索索引尚未构建(纯 FTS 降级可用)', true);
    } else {
      push(`qmd 检索索引可打开(${status.documents} 篇 · 待嵌入 ${status.needsEmbedding})`, true);
    }
  }

  try {
    const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
    const inbox = await listInbox(storage);
    push(`inbox 待审 ${inbox.length}`, true);
    push('迁移标记存在', await storage.exists('.trove/migrated-v2.json'));
  } catch (e) {
    push(`lessons 布局可读 —— ${(e as Error).message}`, false);
  }

  try {
    const search = await getSearchStatus(paths.vault, paths.cache);
    push(`search cache(会话索引 ${search.sessions.indexedSessions}/${search.sessions.totalSessions})`, true);
  } catch (e) {
    push(`search cache —— ${(e as Error).message}`, false);
  }

  try {
    const probe = join(paths.tmp, `doctor-${Date.now()}.tmp`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    push('磁盘 tmp 可写', true);
  } catch (e) {
    push(`磁盘 tmp 可写 —— ${(e as Error).message}`, false);
  }

  try {
    const d = await daemonState(paths);
    push(d.running ? `daemon 运行中 (pid ${d.pid})` : 'daemon 未运行', true);
  } catch (e) {
    push(`daemon 状态 —— ${(e as Error).message}`, false);
  }

  let failed = false;
  for (const [label, ok] of results) {
    out(`${ok ? pc.green('✓') : pc.red('!')} ${label}`);
    if (!ok) failed = true;
  }
  if (failed) throw new Error('doctor 检查未全部通过');
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
  const [index, libraryPending, daemon, remote, lessons, learnPending] = await Promise.all([
    loadLibraryIndex(paths.vault),
    computeLibraryPending(paths.vault, state),
    daemonState(paths),
    probe,
    computeLessonsSummary(paths.vault),
    pendingLearnCount(paths),
  ]);

  const nowMs = now();
  out(
    [
      ...formatStatus(report, {
        library: index ? { skills: Object.keys(index.skills).length } : null,
      }),
...formatLessons(lessons, learnPending),
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

/** config 改动后,若 daemon 在跑就按新配置重启,让启动期参数(间隔/时间窗/学习批量)立即生效。 */
async function restartDaemonForConfig(
  paths: TrovePaths,
  config: Config,
  restart: (opts: RestartDaemonOptions) => Promise<{ pid: number; wasRunning: boolean }>,
  out: (l: string) => void,
  now: () => number,
): Promise<void> {
  if (!(await daemonState(paths)).running) return;
  const since = config.daemon.since;
  parseSince(since, now()); // 拦住被写坏的时间窗,别用非法参数拉起 daemon
  const intervalSeconds = Math.max(5, Number(config.daemon.intervalSeconds) || 300);
  const { pid } = await restart({ paths, intervalSeconds, since });
  out(`  daemon: 已按新配置重启 (pid ${pid}) · 每 ${intervalSeconds}s · 时间窗 ${since}`);
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
  const name =
    opts.name ?? (interactive ? await text({ message: '设备名', initialValue: hostname() }) : hostname());
  if (isCancel(name)) {
    err('已取消。');
    return 1;
  }

  // 远端配置:命令行 flag 优先,其次交互引导(先选类型),都没有则进入本地模式
  let remoteConfig: RemoteConfig;
  if (opts.type === 's3') {
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
  } else if (opts.url) {
    // WebDAV:命令行给了地址就走 flag 路径;填了地址就必须有密码
    const password = opts.password ?? process.env.TROVE_PASSWORD;
    if (!password) throw new Error('未提供密码(--password 或 TROVE_PASSWORD)。');
    remoteConfig = {
      type: 'webdav',
      url: opts.url,
      username: opts.username ?? 'webdav',
      password,
    };
  } else if (interactive) {
    // 交互且没给 flag:先选远端类型(WebDAV / S3),再按类型问字段
    const picked = await promptRemoteConfig(existing.remote, true);
    if (!picked) {
      err('已取消。');
      return 1;
    }
    remoteConfig = picked;
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
  config: Config,
): DaemonRuntime {
  const intervalSeconds = Math.max(5, Number(opts.interval) || 300);
  return {
    paths,
    intervalSeconds,
    since: opts.since,
    ensureDeps: async (progress) => {
      const learn = readLearnConfig(config);
      if (!learn.search.enabled) return '检索后端已禁用(learn.search.enabled=false),跳过索引构建';
      const backend = await searchBackendConfig(paths);
      if (!backend) return '检索后端配置不可读,检索降级纯 FTS5';
      progress.phase('索引', `检查 ${learn.search.model}`);
      try {
        const r = await syncQmdIndex(paths.vault, backend);
        return `qmd 检索索引就绪: ${r.documents} 篇`;
      } catch (e) {
        return `qmd 检索索引构建失败(${(e as Error).message}),检索降级纯 FTS5`;
      }
    },
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
      const queue = JobQueue.open(paths.learnDb);
      try {
        await migrateJsonQueue(paths.learnQueue, queue, paths.vault);
        const n = await enqueueLearnSessions(paths.vault, queue, ids);
        return n ? `经验提取入队 ${n} 个新会话` : undefined;
      } finally {
        queue.close();
      }
    },
    learnTick: async () => {
      // 每 tick 重读配置,模型端点变更即时生效,无需重启 daemon。
      const config = await loadConfig(paths.config);
      const queue = JobQueue.open(paths.learnDb, config.learn.maxAttempts);
      try {
        const pending = await learnPendingBatch(paths.vault, queue, { ...lessonDeps, config, usagePath: paths.usageLog }, learnBatch, {
          log: (l) => void daemonLog(paths, l),
        });
        // 近期方向聚合:hash 不变则 skip(不烧 token),有实际更新才记一行,避免每 tick 刷噪音。
        const recent = await learnRecentMatters(paths.vault, { ...lessonDeps, config });
        const parts = [pending, recent.diff ? '近期方向已刷新' : undefined].filter((x): x is string => !!x);
        const curator = await runCuratorPeriodically(paths, config);
        if (curator) parts.push(curator);
        return parts.length ? parts.join(' · ') : undefined;
      } finally {
        queue.close();
      }
    },
    learnIntervalSeconds,
  };
}

/** daemon 周期任务:最多每 7 天跑一次 curator;失败只记日志,不阻断学习。 */
async function runCuratorPeriodically(
  paths: ReturnType<typeof trovePaths>,
  config: Config,
): Promise<string | undefined> {
  const learn = readLearnConfig(config);
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  try {
    const report = await maybeRunCurator(storage, {
      staleDays: learn.lifecycle.staleDays,
      archiveDays: learn.lifecycle.archiveDays,
      trajectoryDays: learn.lifecycle.trajectoryDays,
      trajectoryMax: learn.lifecycle.trajectoryMax,
    });
    if (!report) return undefined;
    return `curator: stale ${report.stale.length} · 归档 ${report.archived.length} · 复活 ${report.revived.length}`;
  } catch (e) {
    return `curator 失败(不影响学习): ${(e as Error).message}`;
  }
}

/** 主入口:用 commander 定义命令并分发。返回进程退出码。 */
async function cmdWeb(
  opts: { port?: string },
  paths: ReturnType<typeof trovePaths>,
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
  out: (l: string) => void,
): Promise<void> {
  const port = Number(opts.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    out(pc.red(`非法端口:${opts.port}`));
    process.exitCode = 1;
    return;
  }
  const { config, remote, adapters } = await loadRuntime(paths, createRemote, resolveAdapters);
  const server = await startServer({ paths, config, remote, adapters, port });
  out(pc.green(`trove web 已启动:${server.url}`));
  out(pc.dim('  只监听 127.0.0.1,没有鉴权。vault 里有全部会话正文,不要用端口转发暴露出去。'));
  out(pc.dim('  Ctrl-C 停止。'));
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const rawOut = deps.rawOut ?? ((s: string) => process.stdout.write(s));
  const paths = trovePaths(deps.base);
  const lessonDeps = withIndexSync(deps.lessonDeps, paths);
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
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
    await restartDaemonForConfig(paths, await loadConfig(paths.config), restart, out, now);
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
      await restartDaemonForConfig(paths, config, restart, out, now);
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
    .command('whoami')
    .description('查看用户画像、偏好与近期方向')
    .option('--sections <list>', 'profile,styles,recent,all', 'profile,styles,recent')
    .option('--full', '包含年龄/人际关系等敏感分区')
    .option('--json', '输出 JSON')
    .action(async (opts: { sections?: string; full?: boolean; json?: boolean }) => {
      await cmdWhoami(opts, paths, out);
    });

  program
    .command('lessons [action] [value]')
    .description('检索经验/实体/偏好/决策/资源 (action: search / show / list / pin / unpin / forget / restore)')
    .option('--category <name>', 'preferences / entities / experiences / events / resources')
    .option('--type <name>', '记忆类型,如 experiences/gotcha')
    .option('--since <range>', '时间窗,如 7d / 90d / 2026-10-01')
    .option('--limit <n>', '最多显示多少条 (search 默认 10,list 默认 50)')
    .option('--section <heading>', 'show: 只读某个标题小节')
    .option('--lines <range>', 'show: 只读行范围,如 1-80')
    .option('--full', 'show: 读取完整正文(上限 64KB)')
    .option('--from <dir>', 'restore: 恢复来源目录(默认 archive)')
    .option('--json', '输出 JSON')
    .action(
      async (
        action: string | undefined,
        value: string | undefined,
        opts: {
          category?: string;
          type?: string;
          since?: string;
          limit?: string;
          section?: string;
          lines?: string;
          full?: boolean;
          from?: string;
          json?: boolean;
        },
      ) => {
        const a = action ?? 'list';
        if (a === 'search') {
          if (!value) {
            err('用法: trove lessons search <query>');
            return;
          }
          await cmdLessonsSearch(value, opts, paths, out, now());
        } else if (a === 'show') {
          if (!value) {
            err('用法: trove lessons show <path>');
            return;
          }
          await cmdLessonShow(value, opts, paths, out);
        } else if (a === 'list') {
          await cmdLessonsList(opts, paths, out, now());
        } else if (a === 'pin' || a === 'unpin') {
          if (!value) {
            err(`用法: trove lessons ${a} <id|path>`);
            return;
          }
          await cmdLessonPin(value, a === 'pin', paths, out);
        } else if (a === 'forget') {
          if (!value) {
            err('用法: trove lessons forget <id|path>');
            return;
          }
          await cmdLessonForget(value, paths, out);
        } else if (a === 'restore') {
          if (!value) {
            err('用法: trove lessons restore <id|path> [--from <dir>]');
            return;
          }
          await cmdLessonRestore(value, opts.from, paths, out);
        } else {
          err(`未知的 lessons 子命令: ${a}`);
        }
      },
    );

  program
    .command('sessions [action] [value]')
    .description('列出/检索 library 会话 (action: search / show)')
    .option('--harness <id>', '只看某个工具:claude-code / codex / opencode / doubao')
    .option('--device <id>', '只看某台设备')
    .option('--grep <text>', '按标题/摘要/目录/模型搜索')
    .option('--since <range>', '时间窗,如 7d / 90d / 2026-10-01')
    .option('--limit <n>', '最多显示多少条 (list 默认 50,search 默认 10)')
    .option('--exact', 'search: 线性精确检索(覆盖全部工具输出,较慢)')
    .option('--around <text>', 'show: 定位到包含该文字的片段附近')
    .option('--json', '输出 JSON')
    .action(
      async (
        action: string | undefined,
        value: string | undefined,
        opts: {
          harness?: string;
          device?: string;
          grep?: string;
          since?: string;
          limit?: string;
          exact?: boolean;
          around?: string;
          json?: boolean;
        },
      ) => {
        if (action === 'search') {
          if (!value) {
            err('用法: trove sessions search <query>');
            return;
          }
          await cmdSessionsSearch(value, opts, paths, out, now());
        } else if (action === 'show') {
          if (!value) {
            err('用法: trove sessions show <id>');
            return;
          }
          await cmdSessionShow(value, opts, paths, out);
        } else if (action === undefined) {
          await cmdSessions(opts, paths, out);
        } else {
          err(`未知的 sessions 子命令: ${action}`);
        }
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

  const indexCmd = program.command('index').description('检索索引管理');
  indexCmd
    .command('build')
    .description('构建/更新会话检索索引 (~/.trove/cache/search.sqlite)')
    .option('--force', '忽略 hash,全量重建')
    .option('--since <range>', '只索引时间窗内的会话,如 365d')
    .option('--quiet', '不输出统计')
    .action(async (opts: { force?: boolean; since?: string; quiet?: boolean }) => {
      await cmdIndexBuild(opts, paths, out, now());
    });

  program
    .command('mcp')
    .description('启动 stdio MCP 服务(供 Claude Code / Codex / OpenCode 接入)')
    .action(async () => {
      const { runMcpServer } = await import('./mcp/server.js');
      await runMcpServer({ vault: paths.vault, cacheDir: paths.cache, version: VERSION, now, backend: await searchBackendConfig(paths) });
    });

  const skillCmd = program.command('skill').description('安装/卸载 trove skill');
  skillCmd
    .command('install')
    .description('安装到 ~/.claude/skills 与/或 ~/.agents/skills')
    .option('--target <target>', 'claude / agents / both', 'both')
    .option('--force', '覆盖已存在且被修改过的目标')
    .action(async (opts: { target?: string; force?: boolean }) => {
      const result = await installSkill({
        target: (opts.target ?? 'both') as SkillTarget,
        force: opts.force === true,
        version: VERSION,
      });
      for (const p of result.installed) out(pc.green(`已安装: ${p}`));
      for (const p of result.skipped) out(pc.yellow(`跳过: ${p}`));
      if (!result.installed.length && !result.skipped.length) out('没有可安装的目标。');
    });
  skillCmd
    .command('uninstall')
    .description('从 ~/.claude/skills 与/或 ~/.agents/skills 卸载')
    .option('--target <target>', 'claude / agents / both', 'both')
    .option('--force', '删除没有 trove 安装标记的目录')
    .action(async (opts: { target?: string; force?: boolean }) => {
      const result = await uninstallSkill({
        target: (opts.target ?? 'both') as SkillTarget,
        force: opts.force === true,
      });
      for (const p of result.installed) out(pc.green(`已卸载: ${p}`));
      for (const p of result.skipped) out(pc.yellow(`跳过: ${p}`));
      if (!result.installed.length && !result.skipped.length) out('没有找到已安装的 skill。');
    });

  program
    .command('learn')
    .description('经验提取与审计查看')
    .argument('[sessionId]', '会话 id,或子命令:migrate / review / why / trust / curator(缺省需配合 --list)')
    .argument('[arg]', 'review/why/trust 的附加参数(why 的记忆 id 等)')
    .option('--list', '查看最近一次提取的审计 diff')
    .option('--session <id>', '配合 --list 或 review 指定会话')
    .option('--force', '即使已提取过也强制重跑')
    .option('-n, --recent <n>', '按最近优先提取 n 个未学习会话')
    .option('--apply', '配合 migrate:实际执行迁移(默认 dry-run)')
    .option('--rollback <dir>', '配合 migrate:从备份目录恢复')
    .option('--accept-all', '配合 review:接受全部待审候选')
    .option('--reject-all', '配合 review:拒绝全部待审候选')
    .option('--json', '配合 review/status:输出 JSON')
    .option('--level <n>', '配合 trust:显式设置信任等级(0-3)')
    .option('--dry-run', '配合 curator:只统计不写盘')
    .action(
      async (sessionId: string | undefined, arg: string | undefined, opts: { list?: boolean; session?: string; force?: boolean; recent?: string; apply?: boolean; rollback?: string; acceptAll?: boolean; rejectAll?: boolean; json?: boolean; level?: string; dryRun?: boolean }) => {
        if (sessionId === 'migrate') {
          await cmdLearnMigrate(paths, out, opts);
        } else if (sessionId === 'review') {
          await cmdLearnReview(paths, lessonDeps, out, interactive, opts);
        } else if (sessionId === 'why') {
          await cmdLearnWhy(paths, arg, out);
        } else if (sessionId === 'trust') {
          await cmdLearnTrust(paths, out, opts.level);
        } else if (sessionId === 'curator') {
          await cmdLearnCurator(opts, paths, out);
        } else if (sessionId === 'status') {
          await cmdLearnStatus(paths, out, opts.json === true);
        } else if (sessionId === 'pause') {
          await cmdLearnPause(paths, out, true);
        } else if (sessionId === 'resume') {
          await cmdLearnPause(paths, out, false);
        } else if (sessionId === 'retry') {
          await cmdLearnRetry(paths, arg, out);
        } else if (opts.list) {
          await cmdLearnList(paths, opts.session, out);
        } else if (opts.recent !== undefined) {
          const n = Number(opts.recent);
          if (!Number.isInteger(n) || n <= 0) {
            err('用法: trove learn -n <正整数>');
            return;
          }
          const config = lessonDeps?.config ?? (await loadConfig(paths.config));
          out(`准备提取最近 ${n} 个未学习会话...`);
          const summary = await learnRecentBatch(paths.vault, n, { ...lessonDeps, config, onStage: (l) => out(l) }, { log: (l) => out(l) });
          out(pc.green(summary));
        } else if (sessionId) {
          const config = lessonDeps?.config ?? (await loadConfig(paths.config));
          await cmdLearnExtract(paths, sessionId, { ...lessonDeps, config }, out, opts.force === true);
        } else {
          err('用法: trove learn <session-id> | trove learn -n <数量> | trove learn --list [--session <id>] | trove learn review|why|trust|curator|status|pause|resume|retry');
        }
      },
    );

  program
    .command('learn-memo')
    .description('学习 Claude Code 自带记忆系统(~/.claude/projects/*/memory)进入 lessons')
    .option('--force', '即使已学习过也强制重跑')
    .action(async (opts: { force?: boolean }) => {
      await cmdLearnMemo(paths, lessonDeps, out, opts.force === true);
    });

  program
    .command('learn-recent')
    .description('从最近会话聚合用户近期工作方向(时间+项目+主题)写入 recent_matters')
    .option('--force', '即使输入无变化也强制重跑')
    .action(async (opts: { force?: boolean }) => {
      await cmdLearnRecent(paths, lessonDeps, out, opts.force === true);
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
    .option('--json', '输出机器可读 JSON')
    .action(async (opts: { json?: boolean }) => {
      if (opts.json) {
        await cmdStatusJson(paths, out);
        return;
      }
      await cmdStatus(paths, createRemote, resolveAdapters, out, now);
    });

  program
    .command('doctor')
    .description('自检本地配置、学习队列、检索缓存与 daemon 状态')
    .action(async () => {
      await cmdDoctor(paths, out);
    });

  program
    .command('web')
    .description('启动本地 web 界面(只读本地 vault,可触发同步与 daemon 运维)')
    .option('--port <n>', '监听端口(默认 8787)', '8787')
    .action(async (opts: { port?: string }) => {
      await cmdWeb(opts, paths, createRemote, resolveAdapters, out);
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
          lessonDeps,
          config.daemon.learnIntervalSeconds,
          config.daemon.learnBatch,
          config,
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

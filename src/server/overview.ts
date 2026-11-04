import { loadLibraryIndex } from '../core/library/index-file.js';
import { readUsageRecords, summarizeUsage } from '../core/lessons/usage.js';
import { loadState } from '../core/state.js';
import { describeRemote } from '../remote/create-remote.js';
import { computeLibraryPending, computeLessonsSummary, computeStatus } from '../status.js';
import type { Adapter } from '../adapters/index.js';
import type { Config } from '../config.js';
import { daemonState } from '../daemon.js';
import type { TrovePaths } from '../paths.js';

/** 最近 N 天的逐日会话数。没有会话的日子是 0,不是缺一天。 */
export function perDayCounts(
  sessions: Array<{ startedAt?: string }>,
  days: number,
  now: number,
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (!s.startedAt) continue;
    const day = s.startedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, count: counts.get(d) ?? 0 });
  }
  return out;
}

/**
 * 总览:一次回答「我的归档现在是什么状态」。
 * 只读本地 vault 与 daemon 状态文件,绝不回显 config 里的凭证。
 */
export async function buildOverview(opts: {
  paths: TrovePaths;
  config: Config;
  adapters: Adapter[];
  now: () => number;
}): Promise<unknown> {
  const { paths, config, adapters, now } = opts;
  const state = await loadState(paths.state);
  const index = await loadLibraryIndex(paths.vault);
  const [lessons, daemon, usageRecords] = await Promise.all([
    computeLessonsSummary(paths.vault),
    daemonState(paths),
    readUsageRecords(paths.usageLog),
  ]);
  const status = computeStatus({
    state,
    deviceId: config.device.id,
    deviceName: config.device.name,
    adapters,
  });
  const libraryPending = await computeLibraryPending(paths.vault, state);
  const usage = summarizeUsage(usageRecords);

  return {
    device: { id: config.device.id, name: config.device.name },
    remote: { type: config.remote.type, desc: describeRemote(config.remote) },
    daemon: {
      running: daemon.running,
      pid: daemon.pid ?? null,
      status: daemon.status,
    },
    counts: {
      sessions: index ? Object.keys(index.sessions).length : 0,
      events: index
        ? Object.values(index.sessions).reduce((sum, s) => sum + s.canonical.events, 0)
        : 0,
      perDay: perDayCounts(
        index ? Object.values(index.sessions) : [],
        30,
        now(),
      ),
      skills: index ? Object.keys(index.skills).length : 0,
      lessons: lessons.total,
      lessonsByCategory: {
        preferences: lessons.preferences,
        entities: lessons.entities,
        experiences: lessons.experiences,
        events: lessons.events,
        resources: lessons.resources,
      },
    },
    pending: {
      raw: status.pending,
      library: libraryPending,
    },
    usage,
    generatedAt: new Date(now()).toISOString(),
  };
}

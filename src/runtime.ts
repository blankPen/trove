import { createAdapters } from './adapters/index.js';
import type { Adapter } from './adapters/index.js';
import { loadConfig, resolveRawSync, type Config, type RemoteConfig } from './config.js';
import { sync } from './core/sync.js';
import { parseSince } from './core/time-window.js';
import type { TrovePaths } from './paths.js';
import { createRemoteFromConfig, isRemoteConfigured, remoteIdentity } from './remote/create-remote.js';
import type { RemoteStore } from './remote/store.js';
import type { Progress } from './progress.js';

export interface Runtime {
  config: Config;
  /** 未配置远端时为 null(本地模式)。 */
  remote: RemoteStore | null;
  adapters: Adapter[];
}

/** 只启用 config.sources 里没被关掉的采集器。 */
export function defaultResolveAdapters(config: Config): Adapter[] {
  return createAdapters().filter((a) => config.sources[a.id]?.enabled !== false);
}

/** CLI 与 web 后端共用的运行时装配。 */
export async function loadRuntime(
  paths: TrovePaths,
  createRemote: (config: RemoteConfig) => RemoteStore,
  resolveAdapters: (config: Config) => Adapter[],
): Promise<Runtime> {
  const config = await loadConfig(paths.config);
  const remote = isRemoteConfigured(config.remote) ? createRemote(config.remote) : null;
  return { config, remote, adapters: resolveAdapters(config) };
}

/**
 * 一次完整同步。web 后端与 CLI 用同一条路径,
 * 所以 web 触发的同步与 `trove sync` 的行为完全一致。
 */
export async function runSyncOnce(opts: {
  paths: TrovePaths;
  runtime: Runtime;
  progress: Progress;
  now: () => number;
  since?: string;
}): Promise<unknown> {
  const { paths, runtime, progress, now } = opts;
  const cutoff = parseSince(opts.since ?? 'all', now());
  return sync({
    adapters: runtime.adapters,
    deviceId: runtime.config.device.id,
    deviceName: runtime.config.device.name,
    vaultRoot: paths.vault,
    statePath: paths.state,
    tmpDir: paths.tmp,
    remote: runtime.remote,
    remoteId: remoteIdentity(runtime.config.remote),
    cutoff,
    progress,
    now,
    rawSync: resolveRawSync(runtime.config),
  });
}

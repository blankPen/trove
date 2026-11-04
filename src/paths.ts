import { homedir } from 'node:os';
import { join } from 'node:path';

/** trove 本地目录布局。 */
export interface TrovePaths {
  base: string;
  config: string;
  vault: string;
  /** 游标 + 推送/拉取水位(单文件,原子写) */
  state: string;
  /** 自身 LLM 调用的 token 用量台账(JSONL,只追加) */
  usageLog: string;
  logs: string;
  tmp: string;
  /** 检索索引缓存(本地、可重建、不参与同步) */
  cache: string;
  daemonPid: string;
  daemonStatus: string;
  daemonLog: string;
  /** learn 待办队列(不在 vault 内,不参与同步) */
  learnQueue: string;
}

/** 从 base 目录推导全部路径。默认 ~/.trove,可用 TROVE_HOME 覆盖;测试可注入临时 base。 */
export function trovePaths(
  base: string = process.env.TROVE_HOME || join(homedir(), '.trove'),
): TrovePaths {
  return {
    base,
    config: join(base, 'config.json'),
    vault: join(base, 'vault'),
    state: join(base, 'state.json'),
    usageLog: join(base, 'usage.jsonl'),
    logs: join(base, 'logs'),
    tmp: join(base, 'tmp'),
    cache: join(base, 'cache'),
    daemonPid: join(base, 'daemon.pid'),
    daemonStatus: join(base, 'daemon.status.json'),
    daemonLog: join(base, 'logs', 'daemon.log'),
    learnQueue: join(base, 'learn-queue.json'),
  };
}

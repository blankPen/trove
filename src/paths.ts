import { homedir } from 'node:os';
import { join } from 'node:path';

/** trove 本地目录布局(设计 §6.1)。 */
export interface TrovePaths {
  base: string;
  config: string;
  vault: string;
  manifest: string;
  logs: string;
  tmp: string;
}

/** 从 base 目录推导全部路径。默认 ~/.trove,可用 TROVE_HOME 覆盖(如迁到数据盘);测试可注入临时 base。 */
export function trovePaths(base: string = process.env.TROVE_HOME || join(homedir(), '.trove')): TrovePaths {
  return {
    base,
    config: join(base, 'config.json'),
    vault: join(base, 'vault'),
    manifest: join(base, 'vault', '.trove', 'manifest.json'),
    logs: join(base, 'logs'),
    tmp: join(base, 'tmp'),
  };
}

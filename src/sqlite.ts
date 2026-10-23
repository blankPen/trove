import { createRequire } from 'node:module';

/**
 * node:sqlite 是 Node 22.5+ 内置模块,但 Vite 5 的依赖扫描不认识它;
 * createRequire 让运行时直接取内置模块,避免打包器解析。
 */
const require = createRequire(import.meta.url);

export type DatabaseSync = InstanceType<typeof import('node:sqlite').DatabaseSync>;

/** node:sqlite 仍是实验模块,加载即打 ExperimentalWarning,所以延迟到真正打开库时再 require。 */
export function openSqlite(path: string, readOnly = true): DatabaseSync {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path, { readOnly });
}

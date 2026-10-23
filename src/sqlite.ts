import { createRequire } from 'node:module';

/**
 * node:sqlite 是 Node 22.5+ 内置模块,但 Vite 5 的依赖扫描不认识它;
 * createRequire 让运行时直接取内置模块,避免打包器解析。
 */
const require = createRequire(import.meta.url);

export const DatabaseSync = require('node:sqlite').DatabaseSync as typeof import('node:sqlite').DatabaseSync;
export type DatabaseSync = InstanceType<typeof DatabaseSync>;

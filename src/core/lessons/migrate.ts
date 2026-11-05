/** 旧库迁移:把 v1 记忆(无 id)补全为 v2 schema;备份整个 lessons 目录,支持回滚。 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LearnConfig } from '../../config.js';
import { libraryLessonsDir } from '../layout.js';
import { idPrefix, inferKind, newMemoryId, parseMemory, renderMemory } from './memory.js';
import type { MemoryV2 } from './memory.js';
import { LocalStorageAdapter } from './storage.js';
import type { StorageAdapter } from './storage.js';

export interface MigrationItem {
  path: string;
  before: string;
  after: string;
  id: string;
}

export interface MigrationPlan {
  items: MigrationItem[];
  alreadyV2: number;
  skipped: string[];
}

export interface MigrationResult {
  migrated: number;
  alreadyV2: number;
  backupDir?: string;
  dryRun: boolean;
}

const SKIP_PREFIXES = ['archive/', 'audit/', 'trajectories/', '.trove/'];
const NON_MEMORY = new Set(['INDEX.md', 'README.md', '.overview.md']);
const MARKER = '.trove/migrated-v2.json';

/** 非记忆文件(审计/归档/轨迹/元数据/点文件)不参与迁移。 */
function isSkippedPath(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (NON_MEMORY.has(path)) return true;
  return path.split('/').some((seg) => seg.startsWith('.'));
}

/** 给一条 v1 记忆渲染 v2 schema:补 id/kind/status/version/evidence/prompt_version,保留旧正文与时间。 */
function renderMigrated(mem: MemoryV2, id: string): string {
  return renderMemory({
    ...mem,
    id,
    kind: inferKind(mem.type),
    status: 'active',
    version: 1,
    evidence: [],
    promptVersion: 'legacy',
  });
}

/** 扫描 lessons 下记忆文件,列出待迁移(无 id 的旧文件)、已 v2 与跳过(非记忆)。 */
export async function planMigration(storage: StorageAdapter, now?: () => Date): Promise<MigrationPlan> {
  const files = await storage.list();
  const items: MigrationItem[] = [];
  const skipped: string[] = [];
  let alreadyV2 = 0;
  for (const path of files) {
    if (isSkippedPath(path)) {
      skipped.push(path);
      continue;
    }
    const text = await storage.read(path);
    if (text === null) continue;
    const mem = parseMemory(text);
    if (!mem) {
      skipped.push(path);
      continue;
    }
    if (mem.id) {
      alreadyV2++;
      continue;
    }
    const id = newMemoryId(idPrefix(mem.type), now?.());
    items.push({ path, before: text, after: renderMigrated(mem, id), id });
  }
  return { items, alreadyV2, skipped };
}

/** 备份 lessons 目录 → 逐条写回迁移结果 → 落 `.trove/migrated-v2.json` 标记。dry-run 或无旧文件不写。 */
export async function applyMigration(
  storage: StorageAdapter,
  plan: MigrationPlan,
  opts: { vaultRoot: string; now?: () => Date; dryRun?: boolean },
): Promise<MigrationResult> {
  if (opts.dryRun === true || plan.items.length === 0) {
    return { migrated: plan.items.length, alreadyV2: plan.alreadyV2, dryRun: opts.dryRun === true };
  }
  const now = opts.now ?? (() => new Date());
  const lessonsDir = libraryLessonsDir(opts.vaultRoot);
  const backupDir = join(dirname(lessonsDir), '..', 'backups', `lessons-${now().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dirname(backupDir), { recursive: true });
  await cp(lessonsDir, backupDir, { recursive: true });
  await writeFile(
    join(backupDir, 'manifest.json'),
    JSON.stringify({ at: now().toISOString(), count: plan.items.length, files: plan.items.map((i) => i.path) }, null, 2) + '\n',
    'utf8',
  );
  for (const item of plan.items) await storage.write(item.path, item.after);
  await storage.write(MARKER, JSON.stringify({ at: now().toISOString(), backupDir, count: plan.items.length }, null, 2));
  return { migrated: plan.items.length, alreadyV2: plan.alreadyV2, backupDir, dryRun: false };
}

/** 便捷入口:计划 + 应用;dry-run 只计算不写。 */
export async function migrateLessons(
  vaultRoot: string,
  opts: { dryRun?: boolean; now?: () => Date } = {},
): Promise<MigrationResult> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const plan = await planMigration(storage, opts.now);
  return applyMigration(storage, plan, { vaultRoot, now: opts.now, dryRun: opts.dryRun });
}

/** 从备份目录恢复文件(覆盖),删除迁移标记,返回恢复条数;备份目录不存在报中文错误。 */
export async function rollbackMigration(vaultRoot: string, backupDir: string): Promise<number> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  try {
    await readdir(backupDir);
  } catch {
    throw new Error(`备份目录不存在: ${backupDir}`);
  }
  let count = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = join(dir, name);
      if ((await stat(abs)).isDirectory()) {
        await walk(abs, relPath);
      } else if (name !== 'manifest.json') {
        await storage.write(relPath, await readFile(abs, 'utf8'));
        count++;
      }
    }
  };
  await walk(backupDir, '');
  await storage.delete(MARKER);
  return count;
}

/** 非 shadow 模式、autoMigrate 开启时,正式学习前自动迁移一次;失败只警告,不阻断学习。 */
export async function autoMigrateLessons(
  vaultRoot: string,
  storage: StorageAdapter,
  learn: LearnConfig,
  warn: (msg: string) => void,
): Promise<void> {
  if (learn.mode === 'shadow' || !learn.autoMigrate) return;
  if (await storage.exists(MARKER)) return;
  const plan = await planMigration(storage);
  if (plan.items.length === 0) return;
  try {
    await applyMigration(storage, plan, { vaultRoot });
  } catch (e) {
    warn(`旧记忆自动迁移失败(不影响学习):${(e as Error).message}`);
  }
}

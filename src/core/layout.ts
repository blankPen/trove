import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 设备事实层的目录名(原 `devices`)。 */
export const RAW_DIR = 'raw';
/** 个人资产层的目录名。 */
export const LIBRARY_DIR = 'library';

export function rawDeviceDir(vaultRoot: string, deviceId: string): string {
  return join(vaultRoot, RAW_DIR, deviceId);
}

export function rawFilePath(
  vaultRoot: string,
  deviceId: string,
  harness: string,
  relPath: string,
): string {
  return join(rawDeviceDir(vaultRoot, deviceId), harness, ...relPath.split('/'));
}

export function libraryDir(vaultRoot: string): string {
  return join(vaultRoot, LIBRARY_DIR);
}

export function librarySessionsDir(vaultRoot: string): string {
  return join(libraryDir(vaultRoot), 'sessions');
}

export function libraryIndexDir(vaultRoot: string): string {
  return join(libraryDir(vaultRoot), 'index');
}

export function librarySkillsDir(vaultRoot: string): string {
  return join(libraryDir(vaultRoot), 'skills');
}

export function libraryLessonsDir(vaultRoot: string): string {
  return join(libraryDir(vaultRoot), 'lessons');
}

/** 会话 id 作为目录名:不安全字符替换,发生替换时附 hash 防碰撞。 */
export function safeSessionName(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  if (clean === id && clean) return clean;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${clean || 'session'}-${hash}`;
}

/** 单设备会话文件:library/sessions/<harness>/<session>/<device>.jsonl */
export function librarySessionRelPath(
  harness: string,
  sessionId: string,
  deviceId: string,
): string {
  return `sessions/${harness}/${safeSessionName(sessionId)}/${deviceId}.jsonl`;
}

/** 多设备并集文件:library/sessions/<harness>/<session>/merged.<hash8>.jsonl */
export function libraryMergedRelPath(
  harness: string,
  sessionId: string,
  hash: string,
): string {
  return `sessions/${harness}/${safeSessionName(sessionId)}/merged.${hash.slice(0, 8)}.jsonl`;
}

/** 建立 library 骨架(幂等);lessons 先留说明文件。 */
export async function ensureLibraryLayout(vaultRoot: string): Promise<void> {
  await mkdir(librarySessionsDir(vaultRoot), { recursive: true });
  await mkdir(libraryIndexDir(vaultRoot), { recursive: true });
  await mkdir(librarySkillsDir(vaultRoot), { recursive: true });
  await mkdir(libraryLessonsDir(vaultRoot), { recursive: true });
  const readme = join(libraryLessonsDir(vaultRoot), 'README.md');
  try {
    await access(readme, constants.F_OK);
  } catch {
    await writeFile(
      readme,
      '# lessons\n\n学习沉淀占位目录。后续按主题存放经验、总结与可复用结论，\n' +
        '每条内容用 `(harness, session, seq)` 引用会话，不复制正文。\n',
      'utf8',
    );
  }
}

/** 删除旧版挂在 raw/<device>/<harness>/_events 下的派生数据(可重建)。 */
export async function cleanupLegacyEvents(vaultRoot: string): Promise<number> {
  const rawRoot = join(vaultRoot, RAW_DIR);
  let devices: string[] = [];
  try {
    devices = (await readdir(rawRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const device of devices) {
    let harnesses: string[] = [];
    try {
      harnesses = (await readdir(join(rawRoot, device), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const harness of harnesses) {
      const legacy = join(rawRoot, device, harness, '_events');
      try {
        await access(legacy, constants.F_OK);
        await rm(legacy, { recursive: true, force: true });
        removed++;
      } catch {
        // 不存在
      }
    }
  }
  return removed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次性布局迁移:`vault/devices` → `vault/raw`。
 * 两边同时存在时拒绝迁移,交给人工确认,绝不静默合并。
 */
export async function migrateLegacyLayout(vaultRoot: string): Promise<'renamed' | 'none'> {
  const legacy = join(vaultRoot, 'devices');
  const next = join(vaultRoot, RAW_DIR);
  const [hasLegacy, hasNext] = await Promise.all([exists(legacy), exists(next)]);
  if (!hasLegacy) return 'none';
  if (hasNext) throw new Error('vault 中 devices/ 与 raw/ 同时存在,请先人工确认后再迁移');
  await rename(legacy, next);
  return 'renamed';
}

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanSource } from './adapters/scan.js';
import type { Source } from './adapters/types.js';
import { computeFingerprint } from './core/fingerprint.js';
import { fingerprintsEqual } from './core/planner.js';

export interface CollectResult {
  /** 新复制/更新的文件数 */
  copied: number;
  /** 指纹未变、无需复制的文件数 */
  skipped: number;
}

/**
 * collect:agent 原始目录 → 本地 vault(设计 §5、§10.3 ① SCAN)。
 *
 * - 白名单 ∩ 排除后逐文件比对指纹,未变则跳过(阶段 1:全量比对 + 整传)
 * - 变化则原子复制(临时文件 + rename),源文件零改写(原则 1)
 * - 源目录删了 → vault 不动(只增不删,原则 3)
 */
export async function collectSource(opts: {
  source: Source;
  deviceId: string;
  vaultRoot: string;
}): Promise<CollectResult> {
  const { source, deviceId, vaultRoot } = opts;
  const files = await scanSource(source);

  let copied = 0;
  let skipped = 0;

  for (const f of files) {
    const dst = join(vaultRoot, 'devices', deviceId, f.vaultPath);
    const srcFp = await computeFingerprint(f.absPath);

    let dstFp = null;
    try {
      dstFp = await computeFingerprint(dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (dstFp && fingerprintsEqual(srcFp, dstFp)) {
      skipped++;
      continue;
    }

    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${randomUUID()}`;
    await copyFile(f.absPath, tmp);
    await rename(tmp, dst);
    copied++;
  }

  return { copied, skipped };
}

import { createHash } from 'node:crypto';
import type { ChunkRef } from './chunker.js';

/**
 * 远端布局(每设备自描述,对象数尽量少):
 *
 *   <device>/index.json                             设备索引(清单 + 块哈希都在这里)
 *   <device>/meta.json                              设备名 / lastSeen
 *   <device>/chunks/<harness>/<key>.<gen>.<off>-<len>.bin   不可变块
 *
 * 每个 harness 只有一个目录,避免"每会话多级 MKCOL"的数千次往返;
 * 索引是单次提交点,块先传、索引后写。
 * key = base64url(relPath),避免中文、空格、'..' 进入远端路径。
 */

export interface IndexItem {
  harness: string;
  key: string;
  relPath: string;
  sessionKey: string;
  generation: string;
  size: number;
  chunks: ChunkRef[];
  /** chunks 数组的 sha256,拉取时判断是否需要取索引里的块列表 */
  chunksHash: string;
  updatedAt: number;
}

export interface DeviceIndex {
  v: 1;
  deviceId: string;
  updatedAt: number;
  items: Record<string, IndexItem>;
}

export interface DeviceMeta {
  id: string;
  name: string;
  lastSeen: number;
}

export function chunksHash(chunks: readonly ChunkRef[]): string {
  return createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
}

export function encodeKey(relPath: string): string {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

/** 解码并校验远端不可信输入,拒绝绝对路径/穿越/反斜杠/NUL。 */
export function decodeKey(key: string): string {
  let rel: string;
  try {
    rel = Buffer.from(key, 'base64url').toString('utf8');
  } catch {
    throw new Error(`非法 path key: ${key}`);
  }
  if (!validateRelPath(rel)) throw new Error(`非法路径(远端不可信): ${rel}`);
  return rel;
}

export function validateRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) {
    return false;
  }
  const parts = relPath.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

export function itemKey(harness: string, key: string): string {
  return `${harness}:${key}`;
}

/** 设备在远端的根目录:raw/<device>;library 是另一棵独立的树。 */
export function deviceRemoteRoot(deviceId: string): string {
  return `raw/${deviceId}`;
}

export function indexPath(deviceId: string): string {
  return `${deviceRemoteRoot(deviceId)}/index.json`;
}

export function metaPath(deviceId: string): string {
  return `${deviceRemoteRoot(deviceId)}/meta.json`;
}

/**
 * 扁平块路径:同一 harness 共用一个目录,文件名自带 key/世代/区间。
 * 超长 key(深层项目路径)改用 key+generation 的哈希前缀,保证文件名 <= 240。
 */
export function chunkRemotePath(
  deviceId: string,
  harness: string,
  key: string,
  generation: string,
  chunk: { offset: number; length: number },
): string {
  const suffix = `${String(chunk.offset).padStart(12, '0')}-${chunk.length}.bin`;
  const plain = `${key}.${generation}.${suffix}`;
  const name =
    plain.length <= 240
      ? plain
      : `${createHash('sha256').update(`${key}:${generation}`).digest('hex').slice(0, 32)}.${suffix}`;
  return `${deviceRemoteRoot(deviceId)}/chunks/${harness}/${name}`;
}

/** 校验索引项(远端不可信):块必须从 0 连续铺满整个文件。 */
export function validateIndexItem(item: IndexItem): void {
  if (!validateRelPath(item.relPath)) throw new Error(`非法路径(远端不可信): ${item.relPath}`);
  if (decodeKey(item.key) !== item.relPath) throw new Error(`远端索引路径不一致: ${item.relPath}`);
  if (!item.generation || item.generation.includes('/') || item.generation.includes('.')) {
    throw new Error(`远端世代名非法: ${item.generation}`);
  }
  let offset = 0;
  for (const c of item.chunks) {
    if (c.offset !== offset || c.length <= 0 || !/^[0-9a-f]{64}$/.test(c.sha256)) {
      throw new Error(`远端块布局非法: ${item.relPath}`);
    }
    offset += c.length;
  }
  if (offset !== item.size) throw new Error(`远端块未铺满文件: ${item.relPath}`);
  if (chunksHash(item.chunks) !== item.chunksHash) {
    throw new Error(`远端块哈希不一致: ${item.relPath}`);
  }
}

/** 共享数据模型(设计 §7)。 */

export interface Fingerprint {
  /** 字节数 */
  size: number;
  /** 修改时间(ms)—— 仅用于本地缓存判定,不参与跨设备比较 */
  mtime: number;
  /** 前 512 字节的 sha256(十六进制) */
  headHash: string;
}

export interface ManifestEntry {
  /** vault 内相对路径 */
  path: string;
  fingerprint: Fingerprint;
  /** 已确认同步到远端的字节数 */
  syncedSize: number;
  syncedAt: number;
}

/** manifest 仅本地保存,per-device(设计 §7.2)。 */
export type Manifest = Record<string, ManifestEntry>;

/** 阶段 1 planner 只输出 skip / full(设计 §14,offset 续传推迟到阶段 2)。 */
export type PlanAction = 'skip' | 'full';

export interface PlanItem {
  /** vault 内相对路径 */
  path: string;
  action: PlanAction;
  reason: string;
}

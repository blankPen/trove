/**
 * adapter 抽象(设计 §8):纯声明式 Source 接口。
 * 接一个新 agent = 新增一个描述文件 + 一组 fixture 测试,不改动同步逻辑。
 */

export interface Source {
  /** 稳定标识,同时是 vault 里该 agent 的目录名前缀,如 'claude-code' */
  id: string;
  displayName: string;
  /** 扫描根目录(绝对路径) */
  root: string;
  /** 白名单 glob,相对 root(设计原则 2:白名单不是黑名单) */
  patterns: string[];
  /** 硬性排除 glob(凭证等),相对 root —— 优先级高于白名单 */
  exclusions: string[];
  /** 把源文件绝对路径映射为 vault 相对路径(以 agent id 为前缀,不含设备分区) */
  mapToVaultPath: (absPath: string) => string;
  /** 判定"会话"文件的 vault 相对 glob(相对 agent id 前缀),供 status 计数 */
  sessionGlob: string;
}

/** 扫描产出的一个待归档文件。 */
export interface SourceFile {
  /** 源文件绝对路径 */
  absPath: string;
  /** vault 相对路径(agent 前缀已加,设备分区由 collect 负责) */
  vaultPath: string;
}

export interface RemoteEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/** 远端只要求 7 个原语;WebDAV/内存实现同一接口,编排逻辑可单测。 */
export interface RemoteStore {
  /** 列出某个目录的直接子项(不递归);目录不存在返回空数组。 */
  list(path: string): Promise<RemoteEntry[]>;

  /** 远端根下的设备目录名(无嵌套)。 */
  listDevices(): Promise<string[]>;

  /** 读取 JSON;不存在返回 null。 */
  readJson(path: string): Promise<unknown | null>;

  /** 原子写入 JSON(实现负责覆盖)。 */
  writeJson(path: string, value: unknown): Promise<void>;

  /** 上传本地文件(实现自动建父目录);range 用于只传一个块。 */
  writeFile(
    path: string,
    localPath: string,
    range?: { offset: number; length: number },
  ): Promise<void>;

  /** 下载远端文件到本地路径(字节一致)。 */
  readFile(path: string, localPath: string): Promise<void>;

  /** 删除单个文件;不存在时忽略。 */
  delete(path: string): Promise<void>;
}

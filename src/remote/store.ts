export interface RemoteEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  /** 最后修改时间(ms);后端不提供时缺省,清理逻辑对缺失值一律不删。 */
  mtime?: number;
}

/** 远端只要求 7 个原语;WebDAV/内存实现同一接口,编排逻辑可单测。 */
export interface RemoteStore {
  /** 列出某个目录的直接子项(不递归);目录不存在返回空数组。signal 用于短超时探测。 */
  list(path: string, signal?: AbortSignal): Promise<RemoteEntry[]>;

  /**
   * 递归列出前缀下所有文件,name 为完整路径。对象存储一次 ListObjectsV2 即可,
   * 避免逐目录几千次往返。不实现时调用方回退为逐层 list。
   */
  listAll?(prefix: string, signal?: AbortSignal): Promise<RemoteEntry[]>;

  /** 远端根下的设备目录名(无嵌套)。 */
  listDevices(): Promise<string[]>;

  /** 读取 JSON;不存在返回 null。 */
  readJson(path: string, signal?: AbortSignal): Promise<unknown | null>;

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

  /**
   * 该后端建议的并发上传数。
   * WebDAV 实测并发 PUT 会 ECONNRESET,返回 1;对象存储允许并发,返回更高值。
   * 不实现则按 1 处理。
   */
  concurrencyHint?(): number;

  /**
   * 该后端偏好的文件布局。
   * object:一个文件一个对象(对象存储,控制台可读);chunk:应用层分块(WebDAV)。
   * 不实现则按 chunk 处理。
   */
  layoutHint?(): 'chunk' | 'object';
}

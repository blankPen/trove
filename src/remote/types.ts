/**
 * 远端传输抽象。同步编排逻辑只依赖此接口,便于用内存 fake 做单元测试,
 * 真实实现见 webdav.ts。
 */

export interface RemoteFile {
  /** 相对远端根目录的路径(用 '/' 分隔) */
  path: string;
  size: number;
}

export interface Remote {
  /** 递归列出远端全部文件。 */
  listAll(): Promise<RemoteFile[]>;

  /** 下载远端文件到本地路径(字节一致)。 */
  download(remotePath: string, localPath: string): Promise<void>;

  /** 上传本地文件到远端路径(字节一致,自动创建父目录)。 */
  upload(localPath: string, remotePath: string): Promise<void>;

  /** 删除远端文件(init 连通性探针用「写→读回→删」往返)。 */
  delete(remotePath: string): Promise<void>;
}

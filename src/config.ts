import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 配置数据模型(设计 §10.2)。 */

export interface DeviceConfig {
  id: string;
  name: string;
}

export interface RemoteConfig {
  url: string;
  username: string;
  /** 明文存储,仅存于 config.json(权限 600),跨平台不依赖系统钥匙串。 */
  password: string;
}

export type SourceId = 'claude-code' | 'codex' | 'doubao';

export type SourcesConfig = Partial<Record<SourceId, { enabled: boolean }>>;

export interface Config {
  device: DeviceConfig;
  remote: RemoteConfig;
  sources: SourcesConfig;
}

export function defaultConfig(
  opts: { deviceId?: string; deviceName?: string } = {},
): Config {
  return {
    device: {
      id: opts.deviceId ?? randomUUID(),
      name: opts.deviceName ?? hostname(),
    },
    remote: {
      url: '',
      username: 'webdav',
      password: '',
    },
    // v1 只实现 Claude Code adapter(设计 §8.1),故其余默认关闭。
    sources: {
      'claude-code': { enabled: true },
      codex: { enabled: false },
      doubao: { enabled: false },
    },
  };
}

/** 读取配置;文件不存在时返回默认配置。损坏的 JSON 抛含路径的错误。 */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw err;
  }
  try {
    return JSON.parse(raw) as Config;
  } catch {
    throw new Error(`配置文件损坏,无法解析 JSON: ${path}`);
  }
}

/** 原子写入配置:先写临时文件再 rename,避免写一半损坏(设计原则 5)。含明文密码,权限收紧为 600。 */
export async function saveConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

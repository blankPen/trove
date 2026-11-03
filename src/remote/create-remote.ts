import type { RemoteConfig } from '../config.js';
import { resolveEndpoint } from './s3-vendors.js';
import { S3Store } from './s3-store.js';
import type { RemoteStore } from './store.js';
import { WebDavStore } from './webdav-store.js';

/**
 * 按配置构造远端实现。这是 WebDAV 与 S3 唯一的分叉点:
 * 上层(push/pull/library sync)只认 RemoteStore 接口。
 */
export function createRemoteFromConfig(config: RemoteConfig): RemoteStore {
  if (config.type === 's3') {
    const endpoint = resolveEndpoint({
      provider: config.provider,
      region: config.region,
      endpoint: config.endpoint,
    });
    return new S3Store({
      endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle ?? false,
    });
  }
  return new WebDavStore({
    url: config.url,
    username: config.username,
    password: config.password,
  });
}

/** 配置是否完整到可以连远端。 */
export function isRemoteConfigured(config: RemoteConfig): boolean {
  if (config.type === 's3') {
    return Boolean(
      config.bucket &&
        config.region &&
        config.accessKeyId &&
        config.secretAccessKey &&
        (config.provider || config.endpoint),
    );
  }
  return Boolean(config.url && config.password);
}

/** 远端的可读描述,用于 status 输出。 */
export function describeRemote(config: RemoteConfig): string {
  if (config.type === 's3') {
    const endpoint = (() => {
      try {
        return resolveEndpoint({
          provider: config.provider,
          region: config.region,
          endpoint: config.endpoint,
        });
      } catch {
        return config.endpoint ?? '(未配置)';
      }
    })();
    return `${endpoint} · ${config.bucket || '(未配置 bucket)'}`;
  }
  return config.url;
}

/**
 * 远端身份指纹:用来判断"还是同一个远端吗"。
 *
 * 换后端(WebDAV → S3)后指纹会变,本地记录的推送/拉取水位自动作废,
 * 从而把历史数据整份重推到新后端,而不是以为推过了。
 *
 * 不含凭证 —— 轮换密钥不该触发一次全量重推。
 */
export function remoteIdentity(config: RemoteConfig): string {
  if (config.type === 's3') {
    const endpoint = (() => {
      try {
        return resolveEndpoint({
          provider: config.provider,
          region: config.region,
          endpoint: config.endpoint,
        });
      } catch {
        return config.endpoint ?? '';
      }
    })();
    return `s3:${endpoint}/${config.bucket}`;
  }
  return `webdav:${config.url}`;
}

import { password as clackPassword, select, text } from '@clack/prompts';
import type { RemoteConfig } from '../config.js';
import { S3_VENDORS, vendorById, type S3VendorId } from './s3-vendors.js';

/**
 * 远端后端的交互式配置引导。
 *
 * 顺序:先选后端类型,再按类型问对应字段 —— 用户不需要先知道要填 URL 还是 Bucket。
 */

export type RemoteType = 'webdav' | 's3';

const TYPE_OPTIONS = [
  { value: 'webdav', label: 'WebDAV(自建/第三方网盘)' },
  { value: 's3', label: 'S3 兼容对象存储(阿里云 OSS / 腾讯云 COS)' },
];

export function isCancel(v: unknown): v is symbol {
  return typeof v === 'symbol';
}

/** 问一个文本;返回 undefined 表示用户取消。 */
async function askText(
  message: string,
  initialValue?: string,
  placeholder?: string,
): Promise<string | undefined> {
  const v = await text({
    message,
    initialValue: initialValue ?? '',
    ...(placeholder ? { placeholder } : {}),
  });
  return isCancel(v) ? undefined : (v as string).trim();
}

async function askSecret(message: string): Promise<string | undefined> {
  const v = await clackPassword({ message });
  return isCancel(v) ? undefined : (v as string).trim();
}

/**
 * 交互式引导远端配置。
 *
 * @param existing 当前配置,用作默认值
 * @param interactive 是否交互
 * @param forcedType 强制指定类型(init 的 --type flag)
 * @returns 远端配置;非交互模式返回 undefined
 */
export async function promptRemoteConfig(
  existing: RemoteConfig | undefined,
  interactive: boolean,
  forcedType?: RemoteType,
): Promise<RemoteConfig | undefined> {
  if (!interactive) return undefined;

  let type: RemoteType;
  if (forcedType) {
    type = forcedType;
  } else {
    const picked = await select({
      message: '远端类型',
      options: TYPE_OPTIONS,
      initialValue: existing?.type ?? 'webdav',
    });
    if (isCancel(picked)) return undefined;
    type = picked as RemoteType;
  }

  if (type === 's3') {
    return promptS3(existing?.type === 's3' ? existing : undefined);
  }
  return promptWebDav(existing?.type === 'webdav' ? existing : undefined);
}

async function promptWebDav(existing?: RemoteConfig & { type: 'webdav' }): Promise<RemoteConfig | undefined> {
  const url = await askText('WebDAV 地址', existing?.url, 'https://dav.example.com/trove/');
  if (url === undefined) return undefined;
  const username = await askText('WebDAV 用户名', existing?.username || 'webdav');
  if (username === undefined) return undefined;
  const password = await askSecret('WebDAV 密码(留空 = 不变)');
  if (password === undefined) return undefined;
  return {
    type: 'webdav',
    url,
    username,
    // 留空保留原密码
    password: password === '' ? (existing?.password ?? '') : password,
  };
}

async function promptS3(existing?: RemoteConfig & { type: 's3' }): Promise<RemoteConfig | undefined> {
  const providerId = (existing?.provider ?? 'aliyun') as S3VendorId;
  const picked = await select({
    message: 'S3 厂商',
    options: Object.values(S3_VENDORS).map((v) => ({
      value: v.id,
      label: `${v.label} — ${v.hint}`,
    })),
    initialValue: providerId,
  });
  if (isCancel(picked)) return undefined;
  const vendor = vendorById(picked as string);

  const region = await askText('地域', existing?.region ?? vendor.defaultRegion, vendor.defaultRegion);
  if (region === undefined) return undefined;
  const bucket = await askText('Bucket', existing?.bucket, vendor.id === 'tencent' ? 'my-bucket-1250000000' : 'my-bucket');
  if (bucket === undefined) return undefined;
  const accessKeyId = await askText('AccessKey ID', existing?.accessKeyId);
  if (accessKeyId === undefined) return undefined;
  const secretAccessKey = await askSecret('Secret AccessKey(留空 = 不变)');
  if (secretAccessKey === undefined) return undefined;

  return {
    type: 's3',
    provider: vendor.id,
    region,
    bucket,
    accessKeyId,
    secretAccessKey: secretAccessKey === '' ? (existing?.secretAccessKey ?? '') : secretAccessKey,
    forcePathStyle: existing?.forcePathStyle ?? vendor.forcePathStyle,
  };
}

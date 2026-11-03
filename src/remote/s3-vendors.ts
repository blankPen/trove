/**
 * S3 厂商预设。
 *
 * 两家都提供 AWS S3 兼容 API,差别只在 endpoint 形态与寻址方式:
 * - 阿里云 OSS:官方文档要求 addressing_style=virtual、pathStyleAccessEnabled(false)、
 *   chunkedEncodingEnabled(false);走 path-style 会 403。
 * - 腾讯云 COS:兼容 S3,桶名形如 <name>-<appid>。
 */

export type S3VendorId = 'aliyun' | 'tencent';

export interface S3Vendor {
  id: S3VendorId;
  label: string;
  /** 交互引导里的提示文案。 */
  hint: string;
  defaultRegion: string;
  /** 该厂商的 S3 兼容 endpoint 形态。 */
  endpoint: (region: string) => string;
  /** 阿里云 OSS 默认 virtual-hosted;path-style 会被拒。 */
  forcePathStyle: boolean;
}

export const S3_VENDORS: Record<S3VendorId, S3Vendor> = {
  aliyun: {
    id: 'aliyun',
    label: '阿里云 OSS',
    hint: '需要 AccessKey ID / Secret,以及 Bucket 名与地域(如 cn-hangzhou)。',
    defaultRegion: 'cn-hangzhou',
    endpoint: (region) => `https://s3.oss-${region}.aliyuncs.com`,
    forcePathStyle: false,
  },
  tencent: {
    id: 'tencent',
    label: '腾讯云 COS',
    hint: '需要 SecretId / SecretKey,以及完整 Bucket 名(含 -<appid> 后缀)与地域(如 ap-guangzhou)。',
    defaultRegion: 'ap-guangzhou',
    endpoint: (region) => `https://cos.${region}.myqcloud.com`,
    forcePathStyle: false,
  },
};

export function vendorById(id: string): S3Vendor {
  const v = S3_VENDORS[id as S3VendorId];
  if (!v) {
    throw new Error(`不支持的 S3 厂商: ${id}(目前支持 ${Object.keys(S3_VENDORS).join(' / ')})`);
  }
  return v;
}

export function defaultRegionFor(id: S3VendorId): string {
  return S3_VENDORS[id].defaultRegion;
}

export interface EndpointSpec {
  provider?: S3VendorId;
  region?: string;
  endpoint?: string;
}

/**
 * 解析实际使用的 endpoint:手填优先,否则按厂商 + 地域推导。
 */
export function resolveEndpoint(spec: EndpointSpec): string {
  if (spec.endpoint && spec.endpoint.trim()) {
    return spec.endpoint.trim().replace(/\/+$/, '');
  }
  if (spec.provider) {
    const v = vendorById(spec.provider);
    return v.endpoint(spec.region || v.defaultRegion);
  }
  throw new Error('缺少 S3 endpoint:请指定厂商(provider)或直接填 endpoint。');
}

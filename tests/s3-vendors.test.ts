import { describe, it, expect } from 'vitest';
import {
  S3_VENDORS,
  vendorById,
  resolveEndpoint,
  defaultRegionFor,
} from '../src/remote/s3-vendors.js';

/**
 * 厂商预设。取值依据:
 * - 阿里云 OSS:官方文档「使用 AWS SDK 访问 OSS」给出 S3 兼容 Endpoint 与寻址配置
 * - 腾讯云 COS:官方文档「Accessing COS with AWS S3 SDK」与 COS 地域/域名规则
 */

describe('S3 厂商预设', () => {
  it('只支持阿里云与腾讯云两个厂商', () => {
    expect(Object.keys(S3_VENDORS).sort()).toEqual(['aliyun', 'tencent']);
  });

  it('阿里云 endpoint 走 s3.oss-{region}.aliyuncs.com', () => {
    const v = vendorById('aliyun');
    expect(v.endpoint('cn-hangzhou')).toBe('https://s3.oss-cn-hangzhou.aliyuncs.com');
    expect(v.endpoint('cn-shanghai')).toBe('https://s3.oss-cn-shanghai.aliyuncs.com');
  });

  it('腾讯云 endpoint 走 cos.{region}.myqcloud.com', () => {
    const v = vendorById('tencent');
    expect(v.endpoint('ap-guangzhou')).toBe('https://cos.ap-guangzhou.myqcloud.com');
  });

  it('两家默认使用 virtual-hosted 寻址(path-style 会 403)', () => {
    expect(vendorById('aliyun').forcePathStyle).toBe(false);
    expect(vendorById('tencent').forcePathStyle).toBe(false);
  });

  it('两家默认地域不同', () => {
    expect(defaultRegionFor('aliyun')).toBe('cn-hangzhou');
    expect(defaultRegionFor('tencent')).toBe('ap-guangzhou');
  });

  it('厂商带出展示名与提示文案', () => {
    expect(vendorById('aliyun').label).toContain('阿里云');
    expect(vendorById('tencent').label).toContain('腾讯云');
    expect(vendorById('aliyun').hint).toBeTruthy();
  });

  it('未知厂商 id 抛错', () => {
    expect(() => vendorById('aws')).toThrow(/不支持的.*厂商|未知/);
  });
});

describe('resolveEndpoint', () => {
  it('厂商预设可推导出 endpoint', () => {
    expect(resolveEndpoint({ provider: 'aliyun', region: 'cn-beijing' })).toBe(
      'https://s3.oss-cn-beijing.aliyuncs.com',
    );
  });

  it('手填 endpoint 优先于厂商推导', () => {
    expect(
      resolveEndpoint({ provider: 'aliyun', region: 'cn-hangzhou', endpoint: 'https://custom.example.com' }),
    ).toBe('https://custom.example.com');
  });

  it('自定义 endpoint 去掉末尾斜杠', () => {
    expect(resolveEndpoint({ endpoint: 'https://custom.example.com/' })).toBe(
      'https://custom.example.com',
    );
  });

  it('既无厂商也无 endpoint 抛错', () => {
    expect(() => resolveEndpoint({})).toThrow(/endpoint|厂商/);
  });
});

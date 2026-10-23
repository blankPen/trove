import { describe, it, expect } from 'vitest';
import {
  chunkRemotePath,
  chunksHash,
  decodeKey,
  encodeKey,
  indexPath,
  itemKey,
  metaPath,
  validateIndexItem,
  type IndexItem,
} from '../src/core/remote-layout.js';

const chunk = { offset: 0, length: 4, sha256: 'a'.repeat(64) };

const item = (over: Partial<IndexItem> = {}): IndexItem => ({
  harness: 'codex',
  key: encodeKey('sessions/a.jsonl'),
  relPath: 'sessions/a.jsonl',
  sessionKey: 'sessions/a.jsonl',
  generation: 'g1',
  size: 4,
  chunks: [chunk],
  chunksHash: chunksHash([chunk]),
  updatedAt: 1,
  ...over,
});

describe('远端布局与 key 编码', () => {
  it('relPath 用 base64url 编码,可逆且不含路径分隔符', () => {
    const rel = 'projects/-Users-admin-项目/a b.jsonl';
    const key = encodeKey(rel);
    expect(key).not.toMatch(/[/\\]/);
    expect(decodeKey(key)).toBe(rel);
  });

  it('拒绝路径穿越与绝对路径', () => {
    expect(() => decodeKey(encodeKey('../x'))).toThrow(/非法路径/);
    expect(() => decodeKey(encodeKey('/abs'))).toThrow(/非法路径/);
    expect(() => decodeKey(encodeKey('a/../../b'))).toThrow(/非法路径/);
  });

  it('索引/块路径扁平化:同一 harness 共用一个目录', () => {
    expect(indexPath('dev1')).toBe('raw/dev1/index.json');
    expect(metaPath('dev1')).toBe('raw/dev1/meta.json');
    expect(
      chunkRemotePath('dev1', 'codex', 'K', 'g1', { offset: 8, length: 2 }),
    ).toBe('raw/dev1/chunks/codex/K.g1.000000000008-2.bin');
    expect(itemKey('codex', 'K')).toBe('codex:K');
  });

  it('超长 key 自动改用哈希文件名,长度不超过 240', () => {
    const longKey = 'a'.repeat(195);
    const gen = 'f06afa5f-919e-4fe9-869e-848fbbbafcf6';
    const p = chunkRemotePath('dev1', 'claude-code', longKey, gen, { offset: 0, length: 4 });
    const name = p.split('/').pop()!;
    expect(name.length).toBeLessThanOrEqual(240);
    expect(name).not.toContain(longKey);
    // 同 key/世代确定性
    expect(chunkRemotePath('dev1', 'claude-code', longKey, gen, { offset: 0, length: 4 })).toBe(p);
  });

  it('合法索引项通过校验', () => {
    expect(() => validateIndexItem(item())).not.toThrow();
  });

  it('块清单必须连续铺满文件', () => {
    const gap = item({
      size: 8,
      chunks: [{ offset: 0, length: 4, sha256: 'a'.repeat(64) }, { offset: 4, length: 4, sha256: 'b'.repeat(64) }],
      chunksHash: chunksHash([
        { offset: 0, length: 4, sha256: 'a'.repeat(64) },
        { offset: 4, length: 4, sha256: 'b'.repeat(64) },
      ]),
    });
    expect(() => validateIndexItem(gap)).not.toThrow();
    expect(() => validateIndexItem({ ...gap, size: 10 })).toThrow(/未铺满/);
    expect(() => validateIndexItem({ ...gap, chunks: [gap.chunks[1]!, gap.chunks[0]!] })).toThrow(/布局非法/);
  });

  it('块清单被篡改(chunksHash 不符)→ 拒绝', () => {
    expect(() => validateIndexItem({ ...item(), chunksHash: '0'.repeat(64) })).toThrow(/哈希不一致/);
  });

  it('远端的 relPath / generation 不可信', () => {
    expect(() => validateIndexItem({ ...item(), relPath: '../x' })).toThrow(/非法路径/);
    expect(() => validateIndexItem({ ...item(), generation: '../g' })).toThrow(/世代名非法/);
  });
});

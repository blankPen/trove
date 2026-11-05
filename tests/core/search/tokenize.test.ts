import { describe, expect, it } from 'vitest';
import {
  hasQueryTokens,
  isSingleCjkQuery,
  toFtsQuery,
  tokenizeText,
} from '../../../src/core/search/tokenize.js';

describe('search tokenize', () => {
  it('中文按 bigram 切分，并保留相邻关系', () => {
    expect(tokenizeText('飞书文档编辑')).toBe('飞书 书文 文档 档编 编辑');
    expect(toFtsQuery('飞书文档')).toBe('"飞书 书文 文档"');
  });

  it('英文保留整词，并对驼峰/路径补切分', () => {
    expect(tokenizeText('SignatureDoesNotMatch')).toContain('signaturedoesnotmatch');
    expect(tokenizeText('SignatureDoesNotMatch')).toContain('signature');
    expect(tokenizeText('/Users/admin/orca/trove')).toContain('trove');
  });

  it('混合查询用 AND 连接', () => {
    expect(toFtsQuery('COS 签名')).toBe('"cos" AND "签名"');
    expect(hasQueryTokens('  ')).toBe(false);
  });

  it('命令/路径里的 - 用引号包住,避免 FTS5 语法错误', () => {
    expect(toFtsQuery('finish --discard')).toBe('"finish" AND "--discard" AND "discard"');
  });

  it('剥离中文疑问词,自然语言问句仍能命中实体', () => {
    expect(toFtsQuery('DoubaoWork 是什么')).toBe('"doubaowork" AND "doubao" AND "work"');
    expect(toFtsQuery('豆包办公是什么')).toBe('"豆包 包办 办公"');
  });

  it('识别单字中文查询（需要降级）', () => {
    expect(isSingleCjkQuery('书')).toBe(true);
    expect(isSingleCjkQuery('飞书')).toBe(false);
    expect(isSingleCjkQuery('trove')).toBe(false);
  });
});

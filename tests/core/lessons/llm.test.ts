import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekLlm, MockLlm, parseJsonObject, LlmParseError } from '../../../src/core/lessons/llm.js';
import { readJevConfig, readLlmConfig } from '../../../src/core/lessons/config.js';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    invoke = invoke;
  },
}));

describe('LlmProvider(mock)', () => {
  it('用例 0-1:mock 返回固定对象,全程不发起网络请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发起网络请求'));
    try {
      const mock = new MockLlm(async () => ({ a: 1 }));
      const out = await mock.generate<{ a: number }>('任意提示词', { type: 'object' });
      expect(out).toEqual({ a: 1 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe('模型配置读取', () => {
  it('从 config 读取 llm 段', () => {
    const cfg = readLlmConfig({
      llm: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-test',
      },
    });
    expect(cfg).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
    });
  });

  it('缺 LLM 配置时明确报错并列出缺失键', () => {
    expect(() => readLlmConfig({ llm: { baseUrl: 'x', model: '', apiKey: '' } })).toThrow(/llm.model/);
    expect(() => readLlmConfig(undefined)).toThrow(/llm.baseUrl/);
  });

  it('从 config 读取 jev 段', () => {
    const cfg = readJevConfig({
      jev: { apiKey: 'tsk-test', model: 'jev-latest' },
    });
    expect(cfg).toEqual({ apiKey: 'tsk-test', model: 'jev-latest' });
  });

  it('缺 Jev 配置时明确报错并列出缺失键', () => {
    expect(() => readJevConfig({ jev: { apiKey: 'x', model: '' } })).toThrow(/jev.model/);
    expect(() => readJevConfig(undefined)).toThrow(/jev.apiKey/);
  });
});

describe('parseJsonObject', () => {
  it('解析纯 JSON 文本', () => {
    expect(parseJsonObject('{"topic":"调试","n":1}')).toEqual({ topic: '调试', n: 1 });
  });

  it('去掉 ```json 围栏与首尾空白', () => {
    const fenced = '```json\n{"topic":"调试"}\n```';
    expect(parseJsonObject(fenced)).toEqual({ topic: '调试' });
  });

  it('围栏标记大小写不敏感', () => {
    expect(parseJsonObject('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('非 JSON 文本抛错并带原文片段', () => {
    expect(() => parseJsonObject('不是 JSON 的回复')).toThrow(/无法解析为 JSON:不是 JSON 的回复/);
  });

  it('抛出的错误是 LlmParseError,供上层区分「忽略」与「失败」', () => {
    expect(() => parseJsonObject('不是 JSON')).toThrow(LlmParseError);
  });
});

describe('DeepSeekLlm', () => {
  beforeEach(() => invoke.mockReset());

  it('用配置构造不抛错,且不发起网络请求', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发起网络请求'));
    try {
      const llm = new DeepSeekLlm({
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-test',
      });
      expect(llm).toBeInstanceOf(DeepSeekLlm);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('解析失败时重试一次:首次非 JSON,重试返回合法 JSON', async () => {
    invoke.mockResolvedValueOnce({ content: '这不是 JSON 的回复' });
    invoke.mockResolvedValueOnce({ content: '{"a":1}' });
    const llm = new DeepSeekLlm({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: 'sk-test' });
    const out = await llm.generate<{ a: number }>('任意任务', { type: 'object' });
    expect(out).toEqual({ a: 1 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('重试仍失败时抛 LlmParseError,并只调用两次', async () => {
    invoke.mockResolvedValue({ content: '两次都不是 JSON' });
    const llm = new DeepSeekLlm({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: 'sk-test' });
    await expect(llm.generate('任意任务', { type: 'object' })).rejects.toBeInstanceOf(LlmParseError);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

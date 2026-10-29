import { describe, it, expect, vi } from 'vitest';
import { DeepSeekLlm, MockLlm, parseJsonObject } from '../../src/core/lessons/llm.js';
import { readJevConfig, readLlmConfig } from '../../src/core/lessons/config.js';

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
  it('从环境变量读取 TEXT_MODEL_*', () => {
    const cfg = readLlmConfig({
      TEXT_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
      TEXT_MODEL: 'deepseek-v4-flash',
      TEXT_MODEL_API_KEY: 'sk-test',
    });
    expect(cfg).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
    });
  });

  it('缺 LLM 配置时明确报错并列出缺失键', () => {
    expect(() => readLlmConfig({ TEXT_MODEL_BASE_URL: 'x' })).toThrow(/TEXT_MODEL/);
    expect(() => readLlmConfig({})).toThrow(/TEXT_MODEL_BASE_URL/);
  });

  it('从环境变量读取 TYPESAFE_*', () => {
    const cfg = readJevConfig({
      TYPESAFE_API_KEY: 'tsk-test',
      TYPESAFE_MODEL: 'jev-latest',
    });
    expect(cfg).toEqual({ apiKey: 'tsk-test', model: 'jev-latest' });
  });

  it('缺 Jev 配置时明确报错并列出缺失键', () => {
    expect(() => readJevConfig({ TYPESAFE_API_KEY: 'x' })).toThrow(/TYPESAFE_MODEL/);
    expect(() => readJevConfig({})).toThrow(/TYPESAFE_API_KEY/);
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
});

describe('DeepSeekLlm', () => {
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
});

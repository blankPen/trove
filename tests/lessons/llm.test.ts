import { describe, it, expect, vi } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import {
  DeepSeekLlm,
  MockLlm,
  parseJsonObject,
  usageOfMessage,
} from '../../src/core/lessons/llm.js';
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
  const config = {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-test',
  };

  it('用配置构造不抛错,且不发起网络请求', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发起网络请求'));
    try {
      const llm = new DeepSeekLlm(config);
      expect(llm).toBeInstanceOf(DeepSeekLlm);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('调用后按 task 上报模型与 token 用量', async () => {
    const invoke = vi.spyOn(ChatOpenAI.prototype, 'invoke').mockResolvedValue({
      content: '{"ok":true}',
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    } as never);
    const got: unknown[] = [];
    try {
      const llm = new DeepSeekLlm(config, { onUsage: (u) => void got.push(u) });
      expect(await llm.generate('提示词', {}, 'learn:summarize')).toEqual({ ok: true });
    } finally {
      invoke.mockRestore();
    }
    expect(got).toEqual([
      {
        task: 'learn:summarize',
        model: 'deepseek-v4-flash',
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    ]);
  });

  it('返回无法解析的 JSON 时仍记账(token 已消耗)', async () => {
    const invoke = vi.spyOn(ChatOpenAI.prototype, 'invoke').mockResolvedValue({
      content: '不是 JSON',
      usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    } as never);
    const got: unknown[] = [];
    try {
      const llm = new DeepSeekLlm(config, { onUsage: (u) => void got.push(u) });
      await expect(llm.generate('提示词', {})).rejects.toThrow(/无法解析为 JSON/);
    } finally {
      invoke.mockRestore();
    }
    expect(got).toEqual([
      { task: 'llm', model: 'deepseek-v4-flash', promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    ]);
  });

  it('用量写盘失败不影响生成结果', async () => {
    const invoke = vi.spyOn(ChatOpenAI.prototype, 'invoke').mockResolvedValue({
      content: '{"ok":true}',
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } as never);
    try {
      const llm = new DeepSeekLlm(config, {
        onUsage: () => {
          throw new Error('磁盘炸了');
        },
      });
      await expect(llm.generate('提示词', {}, 'learn:merge')).resolves.toEqual({ ok: true });
    } finally {
      invoke.mockRestore();
    }
  });
});

describe('usageOfMessage', () => {
  it('优先 usage_metadata', () => {
    expect(
      usageOfMessage({ usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('缺 usage_metadata 时回退 response_metadata.tokenUsage', () => {
    expect(
      usageOfMessage({
        response_metadata: { tokenUsage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 } },
      }),
    ).toEqual({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  it('无用量字段返回 null', () => {
    expect(usageOfMessage({ content: 'hi' })).toBeNull();
    expect(usageOfMessage(null)).toBeNull();
  });
});

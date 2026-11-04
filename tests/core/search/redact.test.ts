import { describe, expect, it } from 'vitest';
import { redact } from '../../../src/core/search/redact.js';

describe('redact', () => {
  it('脱敏常见密钥与密码', () => {
    const text = [
      'key sk-abcdefghijklmnopqrst',
      'AKIDabcdefghijk',
      'Bearer abc.def.ghi',
      'password=hunter2',
      'api_key: "xyz"',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain('sk-abcdefghijklmnopqrst');
    expect(out).not.toContain('AKIDabcdefghijk');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('"xyz"');
    expect(out).toContain('password=[REDACTED]');
  });

  it('不误伤普通文本', () => {
    expect(redact('fix the bug in parseToken')).toBe('fix the bug in parseToken');
  });
});

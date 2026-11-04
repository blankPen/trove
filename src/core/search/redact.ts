/** 会话/lesson 文本返回前的默认脱敏。正则只能覆盖常见形态，不能替代人工判断。 */

const RULES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\b(?:AKID|LTAI)[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]'],
  [
    /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;，；]+)/gi,
    '$1=[REDACTED]',
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PEM]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

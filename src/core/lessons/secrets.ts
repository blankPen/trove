/** 私密凭据的确定性处理:写入前抹除已知形态,提取前拦截高置信凭据。 */

// shortcut: 敏感值抹除走关键词正则,覆盖常见密钥形态;命中即整段替换为 [REDACTED]。
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*["']?[^\s"'`,;]+["']?/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** 高置信敏感形态(T0 只认这些):AWS 密钥与 PEM 私钥块。其它交给提取时 scrubSecrets。 */
const HIGH_CONFIDENCE_SECRETS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
];

export function hasSensitiveSecret(text: string): boolean {
  return HIGH_CONFIDENCE_SECRETS.some((re) => re.test(text));
}

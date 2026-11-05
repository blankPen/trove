/** 中文 bigram + 英文词/驼峰切分。FTS5 的 unicode61 不切中文，写入与查询必须共用这一套规则。 */

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const TOKEN_RE = /[A-Za-z0-9_@./:\\-]+|[㐀-䶿一-鿿豈-﫿]+/g;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** 单个中文连续段按 2-gram 切分；单字保留，便于构造查询（索引侧不建 unigram）。 */
function cjkBigrams(run: string): string[] {
  if (run.length <= 1) return [run];
  const out: string[] = [];
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  return out;
}

/**
 * ASCII 片段：保留小写整词；含大写或路径分隔符时再补 camelCase / 分隔符切分。
 * 例：SignatureDoesNotMatch → signaturedoesnotmatch signature does not match
 *     /Users/admin/orca → /users/admin/orca users admin orca
 */
function asciiTokens(token: string): string[] {
  const lower = token.toLowerCase();
  const out = [lower];
  if (/[A-Z]/.test(token) || /[/_.-]/.test(token)) {
    const parts = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);
    for (const part of parts) {
      const p = part.toLowerCase();
      if (p && p !== lower && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** 写入 FTS5 的分词文本（空格分隔）。 */
export function tokenizeText(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0]!;
    if (CJK_RE.test(token)) out.push(...cjkBigrams(token));
    else out.push(...asciiTokens(token));
  }
  return out.join(' ');
}

/**
 * 构造 FTS5 MATCH 查询：中文段用 bigram 短语保留相邻关系，多段用 AND。
 * 例：飞书文档 → "飞书 书文 文档"；COS 签名 → cos AND "签名"
 */
/** 中文疑问/语气词:自然语言问句里的这些词会让整段 bigram 短语必然落空,先剥离。 */
const CJK_QUESTION_WORDS = /(是什么|为什么|怎么样|什么样|怎么|如何|哪些|哪个|吗|呢)/g;

export function toFtsQuery(query: string): string {
  const terms: string[] = [];
  for (const m of query.replace(CJK_QUESTION_WORDS, ' ').matchAll(TOKEN_RE)) {
    const token = m[0]!;
    if (CJK_RE.test(token)) {
      const bigrams = cjkBigrams(token);
      terms.push(`"${bigrams.join(' ')}"`);
    } else {
      // 双引号包住:路径/命令里的 - . / 会被 FTS5 当操作符(如 finish --discard)
      for (const t of asciiTokens(token)) terms.push(`"${t.replace(/"/g, '""')}"`);
    }
  }
  return terms.join(' AND ');
}

/** 单字中文无法命中 bigram 索引，调用方应降级到线性匹配。 */
export function isSingleCjkQuery(query: string): boolean {
  const q = query.trim();
  return q.length === 1 && CJK_RE.test(q);
}

/** 查询是否包含可检索 token。 */
export function hasQueryTokens(query: string): boolean {
  return toFtsQuery(query).length > 0;
}

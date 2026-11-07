/** 纯文本相似度:字符 2-gram + Dice 系数,不依赖模型或向量索引。 */

export function bigrams(s: string): Set<string> {
  const chars = [...s];
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** Dice 系数:2|A∩B|/(|A|+|B|),0~1。 */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 标题相似度,用于同类型记忆的粗筛。 */
export function titleScore(a: string, b: string): number {
  return dice(bigrams(a), bigrams(b));
}

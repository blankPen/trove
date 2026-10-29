/** 记忆文件 frontmatter 规范:三类记忆共用的前置字段与缺省值。scope 只允许 global 或 project:<slug>。 */

export interface FrontmatterInput {
  type: string;
  title: string;
  tags?: string[];
  scope?: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  supersededBy?: string;
}

const SCOPE_RE = /^(global|project:[A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope);
}

/** 解析后的 frontmatter 字段(与 FrontmatterInput 对称)。 */
export interface ParsedFrontmatter {
  type: string;
  title: string;
  tags: string[];
  scope: string;
  source: string | null;
  createdAt?: string;
  updatedAt?: string;
  supersededBy?: string;
}

/** 切分 frontmatter 块与正文;不是合法 frontmatter 返回 null。 */
function splitFrontmatter(text: string): { block: string; body: string } | null {
  if (!text.startsWith('---')) return null;
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) return null;
  const close = text.indexOf('\n---', firstNewline);
  if (close === -1) return null;
  return { block: text.slice(firstNewline + 1, close), body: text.slice(close + 4).replace(/^\n/, '') };
}

function parseJson(v: string | undefined): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** 反向解析 renderFrontmatter 的输出;无合法 frontmatter 或缺 type 返回 null。 */
export function parseFrontmatter(text: string): ParsedFrontmatter | null {
  const split = splitFrontmatter(text);
  if (!split) return null;
  const fields: Record<string, string> = {};
  for (const line of split.block.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/);
    if (m) fields[m[1]!] = m[2]!;
  }
  const type = fields['type'];
  if (!type) return null;
  const title = parseJson(fields['title']);
  const tags = parseJson(fields['tags']);
  const scope = parseJson(fields['scope']);
  const source = parseJson(fields['source']);
  const createdAt = parseJson(fields['created_at']);
  const updatedAt = parseJson(fields['updated_at']);
  const supersededBy = parseJson(fields['superseded_by']);
  return {
    type,
    title: typeof title === 'string' ? title : '',
    tags: Array.isArray(tags) ? tags.map(String) : [],
    scope: typeof scope === 'string' ? scope : 'global',
    source: typeof source === 'string' ? source : null,
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    ...(typeof supersededBy === 'string' ? { supersededBy } : {}),
  };
}

/** 返回 frontmatter 之后的正文;无合法 frontmatter 返回 null。 */
export function stripFrontmatter(text: string): string | null {
  const split = splitFrontmatter(text);
  return split ? split.body : null;
}

/** 渲染成 YAML frontmatter;字符串用 JSON 序列化(JSON 字符串是合法 YAML 双引号标量)。 */
export function renderFrontmatter(input: FrontmatterInput): string {
  const scope = input.scope ?? 'global';
  if (!isValidScope(scope)) {
    throw new Error(`非法 scope:「${scope}」,仅允许 global 或 project:<slug>`);
  }
  const now = new Date().toISOString();
  const lines = [
    '---',
    `type: ${input.type}`,
    `title: ${JSON.stringify(input.title)}`,
    `tags: ${JSON.stringify(input.tags ?? [])}`,
    `scope: ${scope}`,
    `source: ${JSON.stringify(input.source ?? null)}`,
    `created_at: ${JSON.stringify(input.createdAt ?? now)}`,
    `updated_at: ${JSON.stringify(input.updatedAt ?? now)}`,
  ];
  if (input.supersededBy) lines.push(`superseded_by: ${JSON.stringify(input.supersededBy)}`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}
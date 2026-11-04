/** 用户信息查询：从 lessons/preferences 读取画像、风格与近期方向。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryLessonsDir } from './layout.js';
import { parseFrontmatter, stripFrontmatter } from './lessons/frontmatter.js';
import { clip } from './search/rank.js';

export type WhoamiSection = 'profile' | 'styles' | 'recent' | 'all';

export interface WhoamiOptions {
  sections?: WhoamiSection[];
  full?: boolean;
}

export interface WhoamiResult {
  profile?: string;
  styles?: Record<string, string>;
  recent?: string;
  updatedAt?: string;
}

const PROFILE_HEADINGS = ['我是谁', '职责', '工作背景'];
const SENSITIVE_HEADINGS = ['年龄', '人际关系'];

async function readPreference(vaultRoot: string, name: string): Promise<{ body: string; updatedAt?: string } | null> {
  const path = join(libraryLessonsDir(vaultRoot), 'preferences', `${name}.md`);
  try {
    const raw = await readFile(path, 'utf8');
    const fm = parseFrontmatter(raw);
    const body = stripFrontmatter(raw) ?? raw;
    return { body, ...(fm?.updatedAt ? { updatedAt: fm.updatedAt } : {}) };
  } catch {
    return null;
  }
}

/** 按 ### 标题切分画像；默认只返回职业相关三节，all/full 才带年龄与人际关系。 */
function pickProfile(body: string, full: boolean): string {
  const sections = new Map<string, string>();
  let current = '';
  const buf: string[] = [];
  const flush = (): void => {
    if (current) sections.set(current, buf.join('\n').trim());
    buf.length = 0;
  };
  for (const line of body.split('\n')) {
    const m = /^###\s+(.*)$/.exec(line);
    if (m) {
      flush();
      current = m[1]!.trim();
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  if (sections.size === 0) return clip(body, full ? 3000 : 1800);
  const picked = [...PROFILE_HEADINGS, ...(full ? SENSITIVE_HEADINGS : [])]
    .map((h) => {
      const text = sections.get(h);
      return text ? `### ${h}\n${text}` : '';
    })
    .filter(Boolean);
  return picked.length ? picked.join('\n\n') : clip(body, 1800);
}

export async function readWhoami(vaultRoot: string, opts: WhoamiOptions = {}): Promise<WhoamiResult> {
  const sections = new Set<WhoamiSection>(opts.sections?.length ? opts.sections : ['profile', 'styles', 'recent']);
  const full = opts.full === true || sections.has('all');
  const result: WhoamiResult = {};

  if (sections.has('profile') || sections.has('all')) {
    const profile = await readPreference(vaultRoot, 'profile');
    if (profile) {
      result.profile = pickProfile(profile.body, full);
      if (profile.updatedAt) result.updatedAt = profile.updatedAt;
    }
  }
  if (sections.has('styles') || sections.has('all')) {
    const styles: Record<string, string> = {};
    for (const name of ['coding_style', 'writing_style', 'dialogue_style']) {
      const entry = await readPreference(vaultRoot, name);
      if (entry) styles[name] = clip(entry.body, 800);
    }
    if (Object.keys(styles).length) result.styles = styles;
  }
  if (sections.has('recent') || sections.has('all')) {
    const recent = await readPreference(vaultRoot, 'recent_matters');
    if (recent) result.recent = clip(recent.body, 1800);
  }
  return result;
}

export function formatWhoami(result: WhoamiResult): string {
  const parts: string[] = [];
  if (result.profile) parts.push('## 用户画像\n\n' + result.profile);
  if (result.styles) {
    const labels: Record<string, string> = {
      coding_style: '编码风格',
      writing_style: '写作风格',
      dialogue_style: '对话风格',
    };
    const rows = Object.entries(result.styles).map(([k, v]) => `### ${labels[k] ?? k}\n${v}`);
    if (rows.length) parts.push('## 偏好\n\n' + rows.join('\n\n'));
  }
  if (result.recent) parts.push('## 近期方向\n\n' + result.recent);
  if (result.updatedAt) parts.push(`\n> 画像更新于 ${result.updatedAt}`);
  return parts.length ? parts.join('\n\n') : '没有找到用户画像或偏好记录。';
}

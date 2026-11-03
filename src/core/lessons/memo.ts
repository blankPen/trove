/** 「memo 渠道」:学习 Claude Code 自带记忆系统(~/.claude/projects/<项目>/memory/*.md)。
 * 与「会话渠道」(graph.ts)并行:记忆本身已是「标题+正文+明确 type」的结构化内容,
 * 不归档、不走 select/analyze/extract,直接映射为 MemoryCandidate 复用 merge/write/audit 落盘。 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryLessonsDir } from '../layout.js';
import { ensureLessonsLayout } from './layout.js';
import { LocalStorageAdapter } from './storage.js';
import { readLlmConfig } from './config.js';
import { DeepSeekLlm } from './llm.js';
import type { LlmProvider } from './llm.js';
import { loadExistingMemories } from './existing.js';
import { mergeMemories } from './merge.js';
import { applyOperations } from './write.js';
import { buildMemoryDiff, writeMemoryDiff } from './audit.js';
import { getMemoryType, slugify } from './schema.js';
import type { MemoryCandidate } from './extract.js';
import type { LessonProviderDeps, ExtractionOutcome } from './learn.js';

/** Claude Code 记忆 type → trove 17 类 type。映射表硬编码;project→gotcha 是近似兜底,要调再抽配置。 */
const CLAUDE_MEMO_TYPE_MAP: Record<string, string> = {
  user: 'preferences/profile',
  feedback: 'experiences/correction',
  project: 'experiences/gotcha',
  reference: 'resources/doc',
};

/** 纯查表:Claude Code 记忆 type 映射到 trove type,未知 type 返回 undefined。 */
export function mapClaudeMemoType(claudeType: string): string | undefined {
  return CLAUDE_MEMO_TYPE_MAP[claudeType];
}

export interface ClaudeMemo {
  name: string;
  description: string;
  type: string;
  /** frontmatter 之后的正文(已去首尾空白)。 */
  body: string;
}

/** 解析 Claude Code 记忆文件的 YAML frontmatter。兼容两种变体:顶层 `type:` 或 `metadata:` 块下的 `type:`。 */
export function parseClaudeMemo(text: string): ClaudeMemo | null {
  if (!text.startsWith('---')) return null;
  const close = text.indexOf('\n---', 4);
  if (close === -1) return null;
  const fm = text.slice(4, close);
  const body = text.slice(close + 4).trim();

  let name = '';
  let description = '';
  let type = '';
  let inMetadata = false;
  for (const line of fm.split('\n')) {
    if (inMetadata) {
      // metadata 子块:缩进的 type 优先取顶层(顶层已有时不覆盖)
      const m = /^\s+type\s*:\s*(.*)$/.exec(line);
      if (m && !type) type = m[1]!.trim();
      continue;
    }
    if (/^metadata\s*:/.test(line)) {
      inMetadata = true;
      continue;
    }
    const m = /^(name|description|type)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2]!.trim();
    if (m[1] === 'name') name = val;
    else if (m[1] === 'description') description = val;
    else if (m[1] === 'type') type = val;
  }
  if (!type) return null;
  return { name, description, type, body };
}

/** 遍历 claudeRoot/projects/<项目>/memory 下的 .md 记忆文件,解析并映射为候选;排除各项目的 MEMORY.md 索引。 */
export async function collectClaudeMemos(claudeRoot: string): Promise<MemoryCandidate[]> {
  const projectsRoot = join(claudeRoot, 'projects');
  let projects: string[] = [];
  try {
    projects = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const candidates: MemoryCandidate[] = [];
  for (const project of projects) {
    const memDir = join(projectsRoot, project, 'memory');
    let files: string[] = [];
    try {
      files = await readdir(memDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f === 'MEMORY.md' || !f.endsWith('.md')) continue;
      let text: string;
      try {
        text = await readFile(join(memDir, f), 'utf8');
      } catch {
        continue;
      }
      const memo = parseClaudeMemo(text);
      if (!memo) continue;
      const troveType = mapClaudeMemoType(memo.type);
      if (!troveType) continue;
      const title = (memo.description || memo.name).trim();
      if (!title || !memo.body.trim()) continue;
      candidates.push({
        type: troveType,
        title,
        content: memo.body.trim(),
        slug: slugify(memo.name || title),
        evidence: [],
      });
    }
  }
  return mergeFixedPatchCandidates(candidates);
}

/** patch 到「固定文件名(无占位符)」的同 type 多条合并为一条:merge 层基于同一旧 existing 逐条 patch 会互相覆盖。 */
function mergeFixedPatchCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const groups = new Map<string, MemoryCandidate[]>();
  const out: MemoryCandidate[] = [];
  for (const c of candidates) {
    const schema = getMemoryType(c.type);
    if (schema?.mergeOp === 'patch' && !schema.filename.includes('{')) {
      const g = groups.get(c.type);
      if (g) g.push(c);
      else groups.set(c.type, [c]);
    } else {
      out.push(c);
    }
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
    } else {
      out.push({
        type: group[0]!.type,
        title: group[0]!.title,
        content: group.map((g) => g.content).join('\n\n'),
        slug: group[0]!.slug,
        evidence: [],
      });
    }
  }
  return out;
}

/** memo 渠道编排:幂等键 audit/memo-claude-code.json。只构造 LLM(merge 的 patch/conflict 用),不构造 jev。 */
export async function learnClaudeMemo(
  vaultRoot: string,
  claudeRoot: string,
  deps: LessonProviderDeps = {},
  opts: { force?: boolean } = {},
): Promise<ExtractionOutcome> {
  await ensureLessonsLayout(vaultRoot);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  if (!opts.force && (await storage.exists('audit/memo-claude-code.json'))) {
    return { skipReason: 'already_learned' };
  }
  const candidates = await collectClaudeMemos(claudeRoot);
  if (candidates.length === 0) return { skipReason: 'no_memo' };
  const llm: LlmProvider = deps.llm ?? new DeepSeekLlm(readLlmConfig(deps.config));
  const existing = await loadExistingMemories(storage);
  const ops = await mergeMemories(candidates, existing, { llm });
  await applyOperations(ops, { storage, now: deps.now, source: 'memo-claude-code' });
  const diff = buildMemoryDiff(ops, { sessionId: 'memo-claude-code', project: 'claude-code' });
  await writeMemoryDiff(diff, storage);
  return { diff };
}
/** 经验契约检查与质量决策:五段式骨架、具体字面量、空话、证据硬门。 */
import type { LearnQualityConfig } from '../../config.js';
import type { EvidenceRef, QualityScore } from './memory.js';

export const EXPERIENCE_SECTIONS = ['适用场景', '做法', '验证', '边界与反例'] as const;

export interface LintFinding {
  code: 'missing_section' | 'empty_section' | 'too_short' | 'vague' | 'no_literal';
  message: string;
}

const VAGUE = ['要注意', '注意边界', '视情况而定', '视具体情况', '多思考', '谨慎处理'];
const COMMAND_RE = /\b(npm|pnpm|git|node|tsc|curl|rm|cp|mv|docker|kubectl|python|pytest|vitest|go test|cargo)\b/;

/** 取某 `## <name>` 章节正文;不存在返回 undefined。 */
function sectionBody(content: string, name: string): string | undefined {
  const marker = `## ${name}`;
  const start = content.indexOf(marker);
  if (start === -1) return undefined;
  let end = content.indexOf('\n## ', start + marker.length);
  if (end === -1) end = content.length;
  return content.slice(start + marker.length, end);
}

export function lintExperience(input: { type: string; content: string; evidence: EvidenceRef[] }): LintFinding[] {
  if (!input.type.startsWith('experiences/')) return [];
  const out: LintFinding[] = [];

  if ([...input.content].length < 80) out.push({ code: 'too_short', message: '正文不足 80 码点' });

  const bodies = new Map<string, string>();
  for (const name of EXPERIENCE_SECTIONS) {
    const body = sectionBody(input.content, name);
    if (body === undefined) {
      out.push({ code: 'missing_section', message: `缺「## ${name}」章节` });
      continue;
    }
    bodies.set(name, body);
    if (body.replace(/\s+/g, '').length < 8) out.push({ code: 'empty_section', message: `「## ${name}」章节过短` });
  }

  if (VAGUE.some((v) => input.content.includes(v))) out.push({ code: 'vague', message: '出现空话' });

  const how = bodies.get('做法');
  if (how !== undefined) {
    const hasLiteral =
      /`[^`\n]+`/.test(how) || /\/\S+/.test(how) || /https?:\/\//.test(how) || COMMAND_RE.test(how);
    if (!hasLiteral) out.push({ code: 'no_literal', message: '「## 做法」缺少具体字面量' });
  }

  if (input.evidence.length === 0) out.push({ code: 'empty_section', message: '缺少证据' });

  return out;
}

export function appendEvidenceSection(content: string, refs: EvidenceRef[]): string {
  const body = content.replace(/\s+$/, '');
  const lines = ['## 证据'];
  for (const r of refs) {
    const quote = JSON.stringify([...r.quote].slice(0, 200).join(''));
    const loc = r.path || r.line !== undefined ? ` — ${r.path ?? ''}${r.line !== undefined ? `:${r.line}` : ''}` : '';
    lines.push(`- [${r.session}:${r.seq}] ${quote}${loc}`);
  }
  return `${body}\n${lines.join('\n')}\n`;
}

/** 删除已有 `## 证据` 段(到下一个 `## ` 或文末),保留其它段落;无该段原样返回。 */
export function stripEvidenceSection(content: string): string {
  const marker = '## 证据';
  const start = content.indexOf(marker);
  if (start === -1) return content;
  const next = content.indexOf('\n## ', start + marker.length);
  const head = content.slice(0, start).replace(/\s+$/, '');
  const tail = next === -1 ? '' : content.slice(next);
  return (head + tail).replace(/\s+$/, '') + '\n';
}


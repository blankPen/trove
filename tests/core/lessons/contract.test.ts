import { describe, it, expect } from 'vitest';
import {
  EXPERIENCE_SECTIONS,
  lintExperience,
  appendEvidenceSection,
  stripEvidenceSection,
  decideQuality,
} from '../../../src/core/lessons/contract.js';
import type { QualityScore } from '../../../src/core/lessons/memory.js';

const ev = [{ session: 's', seq: 1, quote: 'xxxxxxxxxxxx' }];

const valid = [
  '## 适用场景',
  '网络请求失败时用于排查',
  '',
  '## 做法',
  '运行 `pnpm build` 检查 dist 产物与类型',
  '',
  '## 验证',
  '构建成功且没有类型错误',
  '',
  '## 边界与反例',
  '不适用于多包 monorepo 的跨包引用',
].join('\n');

const cfg = { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 };
const q = (over: Partial<QualityScore> = {}): QualityScore => ({
  specific: 0.9,
  actionable: 0.9,
  transferable: 0.9,
  evidence: 0.9,
  non_duplicate: 0.9,
  ...over,
});

describe('lintExperience', () => {
  it('四类经验五段式骨架通过', () => {
    for (const type of [
      'experiences/debug_pattern',
      'experiences/workflow',
      'experiences/gotcha',
      'experiences/correction',
    ]) {
      expect(lintExperience({ type, content: valid, evidence: ev })).toEqual([]);
    }
  });

  it('缺段 → missing_section', () => {
    const content = valid.replace('## 做法\n运行 `pnpm build` 检查 dist 产物与类型\n', '');
    expect(lintExperience({ type: 'experiences/debug_pattern', content, evidence: ev }).some((f) => f.code === 'missing_section')).toBe(true);
  });

  it('空段 → empty_section', () => {
    const content = valid.replace('构建成功且没有类型错误', '短');
    expect(lintExperience({ type: 'experiences/debug_pattern', content, evidence: ev }).some((f) => f.code === 'empty_section')).toBe(true);
  });

  it('证据为空 → empty_section', () => {
    expect(lintExperience({ type: 'experiences/debug_pattern', content: valid, evidence: [] }).some((f) => f.code === 'empty_section')).toBe(true);
  });

  it('空话 → vague', () => {
    const content = valid.replace('不适用于多包 monorepo 的跨包引用', '注意边界,谨慎处理');
    expect(lintExperience({ type: 'experiences/debug_pattern', content, evidence: ev }).some((f) => f.code === 'vague')).toBe(true);
  });

  it('做法无具体字面量 → no_literal', () => {
    const content = valid.replace('运行 `pnpm build` 检查 dist 产物与类型', '先检查配置再重启服务试试');
    expect(lintExperience({ type: 'experiences/debug_pattern', content, evidence: ev }).some((f) => f.code === 'no_literal')).toBe(true);
  });

  it('全文不足 80 码点 → too_short', () => {
    expect(lintExperience({ type: 'experiences/debug_pattern', content: '很短的内容', evidence: ev }).some((f) => f.code === 'too_short')).toBe(true);
  });

  it('非经验类型不检查', () => {
    expect(lintExperience({ type: 'preferences/profile', content: '', evidence: [] })).toEqual([]);
    expect(lintExperience({ type: 'events/decision', content: '', evidence: [] })).toEqual([]);
  });

  it('EXPERIENCE_SECTIONS 为四段固定章节', () => {
    expect(EXPERIENCE_SECTIONS).toEqual(['适用场景', '做法', '验证', '边界与反例']);
  });
});

describe('appendEvidenceSection', () => {
  it('去掉尾部空行,追加证据段,quote 用 JSON 转义', () => {
    const out = appendEvidenceSection('正文第一行\n\n', [
      { session: 's', seq: 3, quote: '报错 "ECONNRESET"', path: 'raw/x.jsonl', line: 10 },
    ]);
    expect(out).toBe('正文第一行\n## 证据\n- [s:3] "报错 \\"ECONNRESET\\"" — raw/x.jsonl:10\n');
  });

  it('无 path/line 时省略定位', () => {
    const out = appendEvidenceSection('正文', [{ session: 's', seq: 1, quote: 'abcdefghijkl' }]);
    expect(out).toBe('正文\n## 证据\n- [s:1] "abcdefghijkl"\n');
  });

  it('quote 截断到 200 字符', () => {
    const out = appendEvidenceSection('正文', [{ session: 's', seq: 1, quote: 'x'.repeat(250) }]);
    expect(out).toContain('"'.concat('x'.repeat(200), '"'));
    expect(out).not.toContain('x'.repeat(201));
  });
});

describe('stripEvidenceSection', () => {
  it('删除已有证据段到文末,保留其它段落', () => {
    const out = stripEvidenceSection('## 适用场景\n网络失败时\n\n## 证据\n- [s:1] "xxx"\n');
    expect(out).not.toContain('## 证据');
    expect(out).toContain('## 适用场景');
    expect(out).toContain('网络失败时');
  });

  it('证据段在中间时,切到下一个 ## ', () => {
    const out = stripEvidenceSection('## 适用场景\nx\n\n## 证据\n- [s:1] "xxx"\n\n## 边界与反例\ny\n');
    expect(out).not.toContain('## 证据');
    expect(out).toContain('## 适用场景');
    expect(out).toContain('## 边界与反例');
  });

  it('无证据段原样返回', () => {
    expect(stripEvidenceSection('正文')).toBe('正文');
  });
});

describe('decideQuality', () => {
  it('证据低于硬门 → reject evidence_below_min', () => {
    expect(decideQuality(0.9, q({ evidence: 0.79 }), cfg)).toEqual({ decision: 'reject', reason: 'evidence_below_min' });
  });

  it('total ≥ autoAccept 且五维 ≥0.6 → accept quality_auto', () => {
    expect(decideQuality(0.85, q(), cfg)).toEqual({ decision: 'accept', reason: 'quality_auto' });
  });

  it('total 达标但某维 <0.6 → escalate quality_borderline', () => {
    expect(decideQuality(0.85, q({ specific: 0.5 }), cfg).decision).toBe('escalate');
  });

  it('total ∈ [reviewFloor, autoAccept) → escalate', () => {
    expect(decideQuality(0.7, q(), cfg)).toEqual({ decision: 'escalate', reason: 'quality_borderline' });
  });

  it('total < reviewFloor → reject quality_below_floor', () => {
    expect(decideQuality(0.5, q(), cfg)).toEqual({ decision: 'reject', reason: 'quality_below_floor' });
  });

  it('边界值:证据 0.8 恰好通过硬门,total 0.80 恰好 accept、0.60 恰好 escalate', () => {
    expect(decideQuality(0.8, q({ evidence: 0.8 }), cfg).decision).toBe('accept');
    expect(decideQuality(0.6, q(), cfg).decision).toBe('escalate');
    expect(decideQuality(0.599, q(), cfg).decision).toBe('reject');
  });
});

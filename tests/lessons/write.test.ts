import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOperations } from '../../src/core/lessons/write.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import type { MemoryOp } from '../../src/core/lessons/merge.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-write-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function add(type: string, title: string, path: string, content = '正文内容'): MemoryOp {
  return { op: 'add', type, title, path, content, evidence: [1] };
}

describe('文件写入与索引更新(Stage 7)', () => {
  it('用例 7-1:add 落盘为 .md(含 frontmatter+正文)并进 INDEX 对应分区', async () => {
    await applyOperations([add('experiences/debug_pattern', 'ECONNRESET 时指数退避重试', 'experiences/debug-ecn.md', '错误现象→根因→解法')], { storage });

    const file = await storage.read('experiences/debug-ecn.md');
    expect(file).toContain('type: experiences/debug_pattern');
    expect(file).toContain('title: "ECONNRESET 时指数退避重试"');
    expect(file).toContain('错误现象→根因→解法');

    const index = await storage.read('INDEX.md');
    expect(index).toContain('experiences/debug-ecn.md');
    expect(index!.indexOf('experiences/debug-ecn.md')).toBeGreaterThan(index!.indexOf('## Experiences'));
  });

  it('用例 7-2:patch 更新正文与 updated_at,保留 created_at,并更新 INDEX 摘要', async () => {
    let t = new Date('2026-01-01T00:00:00Z');
    await applyOperations([add('preferences/writing_style', '写作风格', 'preferences/writing_style.md', '旧内容')], { storage, now: () => t });

    const before = await storage.read('preferences/writing_style.md');
    t = new Date('2026-02-01T00:00:00Z');
    await applyOperations([{ op: 'patch', type: 'preferences/writing_style', path: 'preferences/writing_style.md', title: '写作风格', content: '新合并内容', before: '旧内容' }], { storage, now: () => t });

    const after = await storage.read('preferences/writing_style.md');
    expect(after).toContain('新合并内容');
    expect(after).toContain('2026-02-01'); // updated_at 更新
    expect(after).toContain('2026-01-01'); // created_at 保留
    expect(before).not.toContain('新合并内容');

    const index = await storage.read('INDEX.md');
    expect(index).toContain('新合并内容');
  });

  it('用例 7-3:append 追加到文件末尾,INDEX 行数不变', async () => {
    await applyOperations([add('resources/doc', 'README 文档资源', 'resources/docs/readme.md', '旧资源条目')], { storage });
    const indexBefore = await storage.read('INDEX.md');
    const rowsBefore = (indexBefore!.match(/^- /gm) ?? []).length;

    await applyOperations([{ op: 'append', type: 'resources/doc', path: 'resources/docs/readme.md', content: '新资源条目' }], { storage });

    const file = await storage.read('resources/docs/readme.md');
    expect(file).toContain('旧资源条目');
    expect(file).toContain('新资源条目');
    expect(file!.indexOf('新资源条目')).toBeGreaterThan(file!.indexOf('旧资源条目'));

    const indexAfter = await storage.read('INDEX.md');
    const rowsAfter = (indexAfter!.match(/^- /gm) ?? []).length;
    expect(rowsAfter).toBe(rowsBefore);
  });

  it('用例 7-4:.overview.md(L1) Quick Navigation 按类目统计与磁盘一致', async () => {
    const ops: MemoryOp[] = [
      add('preferences/profile', '个人画像', 'preferences/profile.md'),
      add('preferences/writing_style', '写作风格', 'preferences/writing_style.md'),
      add('preferences/coding_style', '编码风格', 'preferences/coding_style.md'),
      add('entities/project', '项目 A', 'entities/projects/a/overview.md'),
      add('entities/project', '项目 B', 'entities/projects/b/overview.md'),
      add('experiences/debug_pattern', '调试 1', 'experiences/debug-1.md'),
      add('experiences/gotcha', '坑 1', 'experiences/gotcha-1.md'),
      add('experiences/workflow', '流程 1', 'experiences/workflow-1.md'),
      add('experiences/correction', '纠错 1', 'experiences/correction-1.md'),
      add('experiences/decision', '决策 1', 'experiences/decision-1.md'),
    ];
    await applyOperations(ops, { storage });

    const overview = await storage.read('.overview.md');
    expect(overview).toContain('`preferences/`: 用户偏好（3 个文件）');
    expect(overview).toContain('`entities/`: 实体库（2 个文件）');
    expect(overview).toContain('`experiences/`: 经验库（5 个文件）');
  });

  it('add 带 source:frontmatter 写入来源会话而非 null', async () => {
    await applyOperations([add('experiences/gotcha', '标题', 'experiences/g.md', '正文')], { storage, source: 'claude-code:705a6169' });

    const file = await storage.read('experiences/g.md');
    expect(file).toContain('source: "claude-code:705a6169"');
  });

  it('patch 带 source:保留来源会话而非回退为 null', async () => {
    const t = new Date('2026-01-01T00:00:00Z');
    await applyOperations([add('experiences/gotcha', '标题', 'experiences/g.md', '旧内容')], { storage, now: () => t, source: 'claude-code:705a6169' });

    await applyOperations([{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '标题', content: '新内容', before: '旧内容' }], { storage, now: () => t, source: 'claude-code:705a6169' });

    const file = await storage.read('experiences/g.md');
    expect(file).toContain('source: "claude-code:705a6169"');
  });

  it('add 带 supersedePath:旧文件移入 archive 并标记 superseded_by,INDEX 替换行', async () => {
    await applyOperations([add('experiences/correction', '脚本应该用 set -x 退出', 'experiences/correction-set-x.md', '用 set -x')], { storage });

    await applyOperations([{ op: 'add', type: 'experiences/correction', path: 'experiences/correction-set-e.md', title: '脚本应该用 set -e 退出', content: '用 set -e', supersedePath: 'experiences/correction-set-x.md', evidence: [1] }], { storage });

    const archived = await storage.read('archive/experiences/correction-set-x.md');
    expect(archived).toContain('superseded_by');
    expect(archived).toContain('experiences/correction-set-e.md');

    expect(await storage.exists('experiences/correction-set-x.md')).toBe(false);
    expect(await storage.exists('experiences/correction-set-e.md')).toBe(true);

    const index = await storage.read('INDEX.md');
    expect(index).not.toContain('experiences/correction-set-x.md');
    expect(index).toContain('experiences/correction-set-e.md');
  });
});

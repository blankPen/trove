import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import { refreshSidecars, touchSidecars, extractBrief, SIDECAR_DIRS } from '../../src/core/lessons/sidecar.js';

let tmp: string | undefined;

async function makeStorage(): Promise<LocalStorageAdapter> {
  tmp = await mkdtemp(join(tmpdir(), 'trove-sidecar-'));
  return new LocalStorageAdapter(join(tmp, 'library/lessons'));
}

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('lessons Sidecar 分层存储(L0/L1)', () => {
  it('用例 S-1:refresh 为根 + 5 类目录生成 .abstract.md 与 .overview.md,共 12 个文件', async () => {
    const storage = await makeStorage();
    const written = await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    expect(written.length).toBe(12);
    for (const d of SIDECAR_DIRS) {
      const dir = d.path ? `${d.path}/` : '';
      expect(written).toContain(`${dir}.overview.md`);
      expect(written).toContain(`${dir}.abstract.md`);
    }
  });

  it('用例 S-2:根 L1 含 H1、Brief、「Quick Navigation」与 5 个类目;L1 不超 4000 字符', async () => {
    const storage = await makeStorage();
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    const overview = await storage.read('.overview.md');
    expect(overview).not.toBeNull();
    expect(overview!.length).toBeLessThanOrEqual(4000);
    expect(overview).toContain('# 学习沉淀概览');
    expect(overview).toContain('## Quick Navigation');
    for (const name of ['preferences', 'entities', 'experiences', 'events', 'resources']) {
      expect(overview).toContain(`\`${name}/\``);
    }
  });

  it('用例 S-3:L0 正文等于 L1 首个段落(H1 后首个 ## 前),且 L0 不超 256 字符', async () => {
    const storage = await makeStorage();
    await storage.write('preferences/writing_style.md', '---\ntype: preferences/type\ntitle: "写作风格"\n---\n正文\n');
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    const overview = await storage.read('preferences/.overview.md');
    const abstract = await storage.read('preferences/.abstract.md');
    expect(overview).not.toBeNull();
    expect(abstract).not.toBeNull();

    // L0 正文 = 从 L1 提取的首个段落
    const brief = extractBrief(overview!);
    expect(brief.length).toBeGreaterThan(0);
    expect(brief.length).toBeLessThanOrEqual(256);
    expect(abstract).toContain(brief);
  });

  it('用例 S-4:sidecar frontmatter 字段齐全(directory/generated_by/freshness/updated_at)', async () => {
    const storage = await makeStorage();
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    const overview = await storage.read('preferences/.overview.md');
    expect(overview).toContain('directory: lessons/preferences/');
    expect(overview).toContain('generated_by:');
    expect(overview).toContain('component: ExtractionPipeline');
    expect(overview).toContain('freshness:');
    expect(overview).toContain('total_entries:');
    expect(overview).toContain('pending_child_changes: 0');
    expect(overview).toContain('updated_at: 2026-10-29T03:00:00.000Z');
  });

  it('用例 S-5:Quick Navigation 枚举子目录(带计数)与直接文件(带描述)', async () => {
    const storage = await makeStorage();
    await storage.write('preferences/writing_style.md', '---\ntype: preferences/type\ntitle: "写作风格"\n---\n正文\n');
    await storage.write('experiences/debug-a.md', '第一行经验描述\n');
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    const pref = await storage.read('preferences/.overview.md');
    expect(pref).toContain('`writing_style.md`');

    const exp = await storage.read('experiences/.overview.md');
    expect(exp).toContain('`debug-a.md`');
    expect(exp).toContain('第一行经验描述');

    const root = await storage.read('.overview.md');
    expect(root).toContain('`preferences/`: 用户偏好（');
  });

  it('用例 S-6:新鲜度 —— 低于 10% 阈值仅递增 pending,跨阈值刷新并归零', async () => {
    const storage = await makeStorage();
    for (let i = 0; i < 20; i++) {
      await storage.write(`experiences/e${i}.md`, `经验 ${i}\n`);
    }
    await refreshSidecars(storage, { trigger: 'memory_write', now: () => new Date('2026-10-29T03:00:00.000Z') });

    // 20 个文件,阈值 10% = 2;第一次触碰仅递增 pending 不重算内容。
    await touchSidecars(storage, ['experiences'], { trigger: 'memory_write', now: () => new Date('2026-10-29T03:00:01.000Z') });
    expect(await storage.read('experiences/.overview.md')).toContain('pending_child_changes: 1');

    // 第二次触碰跨过阈值 → 刷新并归零。
    await touchSidecars(storage, ['experiences'], { trigger: 'memory_write', now: () => new Date('2026-10-29T03:00:02.000Z') });
    expect(await storage.read('experiences/.overview.md')).toContain('pending_child_changes: 0');
  });

  it('用例 S-7:重复 refresh 幂等,内容不变', async () => {
    const storage = await makeStorage();
    await storage.write('experiences/debug-a.md', '第一行经验描述\n');
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });
    const before = await storage.read('experiences/.overview.md');
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });
    const after = await storage.read('experiences/.overview.md');
    expect(after).toBe(before);
  });

  it('用例 S-8:根 Quick Navigation 不把 README.md / memory_diff.json 这类非记忆产物列为直接文件', async () => {
    const storage = await makeStorage();
    await storage.write('README.md', '# lessons\n');
    await storage.write('memory_diff.json', '{"a":1}\n');
    await storage.write('preferences/writing_style.md', '---\ntype: preferences/type\ntitle: "写作风格"\n---\n正文\n');
    await refreshSidecars(storage, { now: () => new Date('2026-10-29T03:00:00.000Z') });

    const root = await storage.read('.overview.md');
    expect(root).not.toContain('README.md');
    expect(root).not.toContain('memory_diff.json');
    expect(root).toContain('`preferences/`: 用户偏好（1 个文件）');
  });
});
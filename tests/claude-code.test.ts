import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeSource } from '../src/adapters/claude-code.js';
import { scanSource } from '../src/adapters/scan.js';

/** 构建一个模拟 ~/.claude 的 fixture 目录,返回 root。 */
async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trove-claude-'));
  const f = async (rel: string, content = 'x') => {
    const p = join(root, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
  };

  // 纳入项
  await f('CLAUDE.md');
  await f('RTK.md');
  await f('history.jsonl');
  await f('projects/-Users-pz-orca-trove/abc123.jsonl');
  await f('projects/-Users-pz-orca-trove/def456.jsonl');
  await f('projects/-Users-pz-other/xyz.jsonl');
  await f('projects/-Users-pz-orca-trove/notes.md'); // 非 jsonl,应排除
  await f('skills/my-skill/SKILL.md');
  await f('skills/other.md');
  await f('plans/plan.md');
  await f('tasks/task.md');
  await f('file-history/fh.jsonl');

  // 排除项
  await f('settings.json');
  await f('daemon.log');
  await f('plugins/big-cache/data.bin');
  await f('downloads/file.png');
  await f('telemetry/events.jsonl');
  await f('paste-cache/paste.txt');
  await f('backups/backup.json');
  await f('shell-snapshots/snap.json');

  return root;
}

describe('claude-code adapter(白名单,设计 §8.2)', () => {
  let root: string;

  beforeEach(async () => {
    root = await buildFixture();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('扫描产出的 vault 路径 = 白名单 ∩ 排除,且带 claude-code 前缀', async () => {
    const source = createClaudeCodeSource(root);
    const files = await scanSource(source);

    const got = files.map((x) => x.vaultPath).sort();
    expect(got).toEqual(
      [
        'claude-code/CLAUDE.md',
        'claude-code/RTK.md',
        'claude-code/file-history/fh.jsonl',
        'claude-code/history.jsonl',
        'claude-code/plans/plan.md',
        'claude-code/projects/-Users-pz-orca-trove/abc123.jsonl',
        'claude-code/projects/-Users-pz-orca-trove/def456.jsonl',
        'claude-code/projects/-Users-pz-other/xyz.jsonl',
        'claude-code/skills/my-skill/SKILL.md',
        'claude-code/skills/other.md',
        'claude-code/tasks/task.md',
      ].sort(),
    );
  });

  it('projects 下只收 .jsonl,不收 notes.md', async () => {
    const files = await scanSource(createClaudeCodeSource(root));
    const projectFiles = files
      .map((x) => x.vaultPath)
      .filter((p) => p.startsWith('claude-code/projects/'));
    expect(projectFiles).toHaveLength(3);
    expect(projectFiles.every((p) => p.endsWith('.jsonl'))).toBe(true);
  });

  it('硬性排除 settings.json / plugins / downloads / telemetry 等', async () => {
    const files = await scanSource(createClaudeCodeSource(root));
    const paths = files.map((x) => x.vaultPath);
    for (const p of paths) {
      expect(p).not.toContain('settings.json');
      expect(p).not.toContain('/plugins/');
      expect(p).not.toContain('/downloads/');
      expect(p).not.toContain('/telemetry/');
      expect(p).not.toContain('/paste-cache/');
      expect(p).not.toContain('/backups/');
      expect(p).not.toContain('/shell-snapshots/');
      expect(p).not.toMatch(/daemon\.log$/);
    }
  });

  it('mapToVaultPath 把项目文件映射为 claude-code/projects/...', () => {
    const source = createClaudeCodeSource(root);
    const abs = join(root, 'projects', '-Users-pz-orca-trove', 'abc123.jsonl');
    expect(source.mapToVaultPath(abs)).toBe(
      'claude-code/projects/-Users-pz-orca-trove/abc123.jsonl',
    );
  });
});

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildLibrary } from '../src/core/library/build.js';
import { loadLibraryIndex } from '../src/core/library/index-file.js';
import { emptyState } from '../src/core/state.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function seedSkill(
  vault: string,
  device: string,
  harness: string,
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  const root = join(vault, 'raw', device, harness, 'skills', dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body);
  }
}

describe('library:skills 汇总', () => {
  it('识别来源、按内容去重、保留版本', async () => {
    const vault = await tmp('trove-skills-');
    await seedSkill(vault, 'dev1', 'claude-code', 'self-skill', {
      'SKILL.md': '---\nname: self-skill\nversion: 1.0.0\n---\n自建技能\n',
    });
    await seedSkill(vault, 'dev1', 'claude-code', 'gh-skill', {
      'SKILL.md': '---\nname: gh-skill\nversion: 2.0.0\n---\n来自 github\n',
      '.git/config':
        '[remote "origin"]\n\turl = https://github.com/acme/gh-skill.git\n',
    });
    await seedSkill(vault, 'dev1', 'codex', 'sh-skill', {
      'SKILL.md': '---\nname: sh-skill\nversion: 0.3.1\n---\n来自 skill.sh\n',
      '.git/config': '[remote "origin"]\n\turl = https://skills.sh/acme/sh-skill\n',
    });

    await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state: emptyState() });
    const index = await loadLibraryIndex(vault);

    expect(Object.keys(index!.skills).sort()).toEqual(['gh-skill', 'self-skill', 'sh-skill']);
    expect(index!.skills['self-skill']!.versions[0]!.source).toBe('self');
    expect(index!.skills['gh-skill']!.versions[0]!.source).toBe('github');
    expect(index!.skills['gh-skill']!.versions[0]!.origin).toBe(
      'https://github.com/acme/gh-skill.git',
    );
    expect(index!.skills['sh-skill']!.versions[0]!.source).toBe('skillsh');
    expect(index!.skills['gh-skill']!.versions[0]!.version).toBe('2.0.0');

    // 版本目录不包含 .git
    const versionDir = join(
      vault,
      'library/skills/gh-skill/versions',
      index!.skills['gh-skill']!.latest,
    );
    expect(await readFile(join(versionDir, 'SKILL.md'), 'utf8')).toContain('来自 github');
    await expect(readFile(join(versionDir, '.git/config'), 'utf8')).rejects.toThrow();
    expect(await readdir(versionDir)).toEqual(['SKILL.md']);
  });

  it('同名技能在两个设备上版本不同时,latest 取更高的 semver', async () => {
    const vault = await tmp('trove-skills-');
    await seedSkill(vault, 'dev1', 'claude-code', 'review', {
      'SKILL.md': '---\nname: review\nversion: 1.0.0\n---\n旧版\n',
    });
    await seedSkill(vault, 'dev2', 'claude-code', 'review', {
      'SKILL.md': '---\nname: review\nversion: 1.2.0\n---\n新版\n',
    });

    await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state: emptyState() });
    await buildLibrary({ vaultRoot: vault, deviceId: 'dev2', state: emptyState() });
    const index = await loadLibraryIndex(vault);
    const skill = index!.skills['review']!;

    expect(skill.versions).toHaveLength(2);
    const latest = skill.versions.find((v) => v.hash === skill.latest)!;
    expect(latest.version).toBe('1.2.0');
    expect(latest.devices).toEqual(['dev2']);
  });
});

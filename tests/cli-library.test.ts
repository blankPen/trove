import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { buildLibrary } from '../src/core/library/build.js';
import { emptyState } from '../src/core/state.js';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-cli-lib-'));
  const vault = join(base, 'vault');
  const skillDir = join(vault, 'raw/dev-cli/claude-code/skills/review');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: review\nversion: 1.0.0\n---\n代码审查\n',
  );
  await buildLibrary({ vaultRoot: vault, deviceId: 'dev-cli', state: emptyState() });

  const lines: string[] = [];
  const deps = {
    base,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    rawOut: () => {},
    isTTY: false,
    now: () => 1_000_000,
  };
  return { base, vault, lines, deps };
}

describe('trove skills / library', () => {
  it('skills list 与 show 输出最新版本与来源', async () => {
    const { lines, deps } = await setup();

    expect(await run(['skills'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('review');
    expect(lines.join('\n')).toContain('v1.0.0');
    expect(lines.join('\n')).toContain('self');

    lines.length = 0;
    expect(await run(['skills', 'show', 'review'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('latest');
    expect(lines.join('\n')).toContain('versions');

    lines.length = 0;
    expect(await run(['skills', 'list', '--json'], deps)).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Array<{ name: string; versions: unknown[] }>;
    expect(parsed[0]).toMatchObject({ name: 'review' });
    expect(parsed[0]!.versions).toHaveLength(1);
  });

  it('启动时把 vault/devices 迁成 vault/raw', async () => {
    const base = await mkdtemp(join(tmpdir(), 'trove-cli-mig-'));
    await mkdir(join(base, 'vault/devices/dev-x/claude-code/projects'), { recursive: true });
    await writeFile(join(base, 'vault/devices/dev-x/claude-code/projects/a.jsonl'), 'x');
    const lines: string[] = [];
    const deps = {
      base,
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
      rawOut: () => {},
      isTTY: false,
      now: () => 1_000_000,
    };

    expect(await run(['library', 'reindex'], deps)).toBe(0);
    expect(await readFile(join(base, 'vault/raw/dev-x/claude-code/projects/a.jsonl'), 'utf8')).toBe('x');
    await expect(readFile(join(base, 'vault/devices'), 'utf8')).rejects.toThrow();
  });

  it('library reindex 重建索引,并建立 lessons 占位', async () => {
    const { vault, lines, deps } = await setup();

    expect(await run(['library', 'reindex'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('索引已重建');

    const readme = await readFile(join(vault, 'library/lessons/README.md'), 'utf8');
    expect(readme).toContain('lessons');
  });
});

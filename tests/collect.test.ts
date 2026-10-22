import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeSource } from '../src/adapters/claude-code.js';
import { collectSource } from '../src/collect.js';

describe('collect(agent 源 → vault,字节一致)', () => {
  let src: string;
  let vaultRoot: string;
  const deviceId = 'a3f2c81e';

  async function write(rel: string, content: string) {
    const p = join(src, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
    return p;
  }

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), 'trove-src-'));
    vaultRoot = await mkdtemp(join(tmpdir(), 'trove-vault-'));
  });

  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('首次 collect 把白名单文件复制到 devices/{id}/claude-code/...', async () => {
    await write('projects/-p/a.jsonl', 'line1\nline2\n');
    await write('CLAUDE.md', '# claude\n');

    const r = await collectSource({
      source: createClaudeCodeSource(src),
      deviceId,
      vaultRoot,
    });

    expect(r.copied).toBe(2);
    expect(r.skipped).toBe(0);

    const vaultJsonl = await readFile(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'projects', '-p', 'a.jsonl'),
      'utf8',
    );
    expect(vaultJsonl).toBe('line1\nline2\n');
    const vaultMd = await readFile(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'CLAUDE.md'),
      'utf8',
    );
    expect(vaultMd).toBe('# claude\n');
  });

  it('第二次 collect 无变化 → 全部 skipped,不再复制', async () => {
    await write('projects/-p/a.jsonl', 'line1\nline2\n');
    await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });

    const r = await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });
    expect(r.copied).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('源文件追加内容 → 重新复制,vault 反映最新完整内容', async () => {
    await write('projects/-p/a.jsonl', 'line1\n');
    await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });

    await write('projects/-p/a.jsonl', 'line1\nline2\nline3\n');
    const r = await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });

    expect(r.copied).toBe(1);
    const vaultJsonl = await readFile(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'projects', '-p', 'a.jsonl'),
      'utf8',
    );
    expect(vaultJsonl).toBe('line1\nline2\nline3\n');
  });

  it('源文件删除后 vault 保留(只增不删,设计原则 3)', async () => {
    await write('projects/-p/a.jsonl', 'keep me\n');
    await write('projects/-p/b.jsonl', 'also keep\n');
    await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });

    // 删除源里的 a.jsonl
    await rm(join(src, 'projects', '-p', 'a.jsonl'));

    const r = await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });
    expect(r.copied).toBe(0);
    // a.jsonl 仍在 vault 里
    const a = await readFile(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'projects', '-p', 'a.jsonl'),
      'utf8',
    );
    expect(a).toBe('keep me\n');
  });

  it('二进制内容也逐字节一致(保真,原则 1)', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x0d]);
    const p = join(src, 'history.jsonl');
    await writeFile(p, bytes);
    await collectSource({ source: createClaudeCodeSource(src), deviceId, vaultRoot });

    const got = await readFile(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'history.jsonl'),
    );
    expect(got.equals(bytes)).toBe(true);
  });
});

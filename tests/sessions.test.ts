import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { listSessions } from '../src/core/sessions.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

interface SeedHeader {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  body?: string;
}

/** 直接落 library 分片与会话文件,模拟 build 的产物。 */
async function seed(vault: string, device: string, h: SeedHeader): Promise<void> {
  const rel = `sessions/${h.harness}/${h.session}/${device}.jsonl`;
  const abs = join(vault, 'library', ...rel.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  const lines = [
    JSON.stringify({
      v: 1,
      seq: 0,
      kind: 'session',
      harness: h.harness,
      session: h.session,
      ...(h.title ? { title: h.title } : {}),
      ...(h.firstText ? { firstText: h.firstText } : {}),
      ...(h.cwd ? { cwd: h.cwd } : {}),
      ...(h.model ? { model: { id: h.model } } : {}),
      ...(h.startedAt ? { startedAt: h.startedAt } : {}),
    }),
    ...(h.body ? [JSON.stringify({ v: 1, seq: 1, kind: 'message', role: 'user', text: h.body })] : []),
  ];
  await writeFile(abs, lines.join('\n') + '\n');

  const shardPath = join(vault, 'library/index', `${device}.json`);
  let shard: {
    v: 1;
    device: string;
    mapper: string;
    updatedAt: string;
    sessions: Record<string, unknown>;
    skills: Record<string, unknown>;
  };
  try {
    shard = JSON.parse(await readFile(shardPath, 'utf8'));
  } catch {
    shard = { v: 1, device, mapper: 'test', updatedAt: '', sessions: {}, skills: {} };
  }
  shard.sessions[`${h.harness}:${h.session}`] = {
    device,
    path: rel,
    hash: `hash-${h.session}`,
    events: lines.length,
    rawSources: [],
    ...(h.title ? { title: h.title } : {}),
    ...(h.firstText ? { firstText: h.firstText } : {}),
    ...(h.cwd ? { cwd: h.cwd } : {}),
    ...(h.model ? { model: h.model } : {}),
    ...(h.startedAt ? { startedAt: h.startedAt } : {}),
  };
  await mkdir(join(vault, 'library/index'), { recursive: true });
  await writeFile(shardPath, JSON.stringify(shard));
  // 每次 seed 后重建统一索引,模拟 build 的行为
  const { rebuildUnifiedIndex } = await import('../src/core/library/index-file.js');
  await rebuildUnifiedIndex(vault);
}

async function fixture(): Promise<string> {
  const vault = await tmp('trove-sessions-');
  await seed(vault, 'dev1', {
    harness: 'claude-code',
    session: 's-a',
    firstText: '为什么我 link 了还是 trove init',
    cwd: '/Users/admin/orca/trove',
    model: 'claude-opus-5',
    startedAt: '2026-10-22T13:00:00.000Z',
    body: '看下 PATH 环境变量',
  });
  await seed(vault, 'dev1', {
    harness: 'opencode',
    session: 's-b',
    title: '优化项目结构',
    cwd: '/Users/admin/pz/docs',
    model: 'glm-4.7',
    startedAt: '2026-10-23T09:00:00.000Z',
  });
  await seed(vault, 'dev2', {
    harness: 'codex',
    session: 's-c',
    firstText: '消化 feishu ingest 文档',
    startedAt: '2026-10-20T09:00:00.000Z',
  });
  return vault;
}

describe('listSessions', () => {
  it('跨设备汇总,按开始时间倒序', async () => {
    const vault = await fixture();
    const all = await listSessions(vault);
    expect(all.map((s) => s.session)).toEqual(['s-b', 's-a', 's-c']);
    expect(all[1]).toMatchObject({
      device: 'dev1',
      harness: 'claude-code',
      cwd: '/Users/admin/orca/trove',
      model: 'claude-opus-5',
      events: 2,
    });
  });

  it('支持按 harness / 设备过滤', async () => {
    const vault = await fixture();
    expect((await listSessions(vault, { harness: 'opencode' })).map((s) => s.session)).toEqual(['s-b']);
    expect((await listSessions(vault, { device: 'dev2' })).map((s) => s.session)).toEqual(['s-c']);
  });

  it('关键词匹配标题、摘要、目录、模型与正文', async () => {
    const vault = await fixture();
    expect((await listSessions(vault, { grep: 'trove init' })).map((s) => s.session)).toEqual(['s-a']);
    expect((await listSessions(vault, { grep: 'GLM-4.7' })).map((s) => s.session)).toEqual(['s-b']);
    expect((await listSessions(vault, { grep: 'pz/docs' })).map((s) => s.session)).toEqual(['s-b']);
    expect((await listSessions(vault, { grep: 'PATH 环境' })).map((s) => s.session)).toEqual(['s-a']);
    expect(await listSessions(vault, { grep: '不存在的关键词' })).toEqual([]);
  });
});

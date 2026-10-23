import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAdapters } from '../src/adapters/index.js';
import { discoverFiles } from '../src/adapters/file-source.js';
import { listSessions } from '../src/adapters/opencode.js';

const HOME = homedir();
const adapters = createAdapters({ home: HOME });
const byId = Object.fromEntries(adapters.map((a) => [a.id, a]));

describe('adapter 注册表', () => {
  it('四个工具全部默认启用', () => {
    expect(adapters.map((a) => a.id).sort()).toEqual(['claude-code', 'codex', 'doubao', 'opencode']);
  });

  it('Claude 排除凭证/缓存,保留 projects 与 transcripts 两套会话', () => {
    const a = byId['claude-code']!;
    if (a.kind !== 'files') throw new Error('claude-code 应为文件源');
    expect(a.source.patterns).toContain('projects/**/*.jsonl');
    expect(a.source.patterns).toContain('transcripts/**/*.jsonl');
    expect(a.source.pruneDirs).toEqual(expect.arrayContaining(['plugins', 'stats', 'bash-snapshots']));
  });

  it('Codex 排除 auth/config/sqlite', () => {
    const a = byId['codex']!;
    if (a.kind !== 'files') throw new Error('codex 应为文件源');
    expect(a.source.exclusions).toEqual(
      expect.arrayContaining(['auth.json', 'config.toml', '*.sqlite', '*.sqlite-wal']),
    );
  });

  it('豆包按 .sessions/<id> 与 conversation/<id> 归组会话', () => {
    const a = byId['doubao']!;
    if (a.kind !== 'files') throw new Error('doubao 应为文件源');
    const key = a.source.sessionKeyOf!;
    expect(key('.sessions/123/agents/a/system/trajectory.jsonl')).toBe('123');
    expect(key('conversation/123/background_history_task/index.json')).toBe('123');
  });
});

const real = (p: string) => existsSync(p);

describe.skipIf(!real(join(HOME, '.claude')))('真实环境:Claude Code', () => {
  it('扫描到 projects + transcripts 的全部会话文件', async () => {
    const a = byId['claude-code']!;
    if (a.kind !== 'files') throw new Error('类型错误');
    const files = await discoverFiles(a.source);
    const sessions = new Set(files.map((f) => f.sessionKey));
    expect(sessions.size).toBeGreaterThan(1000);
    expect(files.some((f) => f.relPath.startsWith('projects/'))).toBe(true);
    expect(files.some((f) => f.relPath.startsWith('transcripts/'))).toBe(true);
    expect(files.some((f) => /settings\.json$/.test(f.relPath))).toBe(false);
  });
});

describe.skipIf(!real(join(HOME, '.codex')))('真实环境:Codex', () => {
  it('扫描到 sessions 下的全部 rollout 文件', async () => {
    const a = byId['codex']!;
    if (a.kind !== 'files') throw new Error('类型错误');
    const files = await discoverFiles(a.source);
    const sessions = new Set(files.map((f) => f.sessionKey));
    expect(sessions.size).toBeGreaterThanOrEqual(5);
    expect(files.some((f) => /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.*\.jsonl$/.test(f.relPath))).toBe(true);
    expect(files.some((f) => /(auth\.json|config\.toml|\.sqlite)/.test(f.relPath))).toBe(false);
  });
});

const DOUBAO = join(
  HOME,
  'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace',
);

describe.skipIf(!real(DOUBAO))('真实环境:豆包', () => {
  it('扫描到全部会话目录的会话内容(不含 scratch/skills)', async () => {
    const a = byId['doubao']!;
    if (a.kind !== 'files') throw new Error('类型错误');
    const files = await discoverFiles(a.source);
    const sessions = new Set(files.map((f) => f.sessionKey));
    expect(sessions.size).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.relPath.endsWith('trajectory.jsonl'))).toBe(true);
    expect(files.some((f) => f.relPath.includes('/scratch/'))).toBe(false);

    // 每个会话目录至少有一个会话正文文件(board/memory/system/socket)
    const { readdir } = await import('node:fs/promises');
    const dirs = (await readdir(join(DOUBAO, '.sessions'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(sessions.size).toBe(dirs.length);
  }, 60_000);
});

const OC_DB = join(HOME, '.local/share/opencode/opencode.db');

describe.skipIf(!real(OC_DB))('真实环境:OpenCode', () => {
  it('列出新旧两套表的全部会话', () => {
    const sessions = listSessions(OC_DB);
    expect(sessions.length).toBeGreaterThanOrEqual(782);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
  });
});

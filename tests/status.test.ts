import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeLibraryPending, computeStatus, probeRemote } from '../src/status.js';
import { emptyState } from '../src/core/state.js';
import { claudeCodeAdapter, codexAdapter, doubaoAdapter, opencodeAdapter } from '../src/adapters/index.js';
import { MemoryRemote } from './helpers/memory-remote.js';

const adapters = [
  claudeCodeAdapter('/tmp/x/.claude'),
  codexAdapter('/tmp/x/.codex'),
  opencodeAdapter('/tmp/x/opencode.db'),
  doubaoAdapter('/tmp/x/ws'),
];

function stateWith(
  entries: Record<
    string,
    Array<{ rel: string; sessionKey: string; size: number; pushed?: number; pushedGen?: string }>
  >,
) {
  const state = emptyState();
  for (const [harness, list] of Object.entries(entries)) {
    for (const e of list) {
      state.sources[harness] ??= {};
      state.sources[harness]![e.rel] = {
        size: e.size,
        mtimeMs: 1,
        prefixHash: 'h',
        generation: 'g',
        sessionKey: e.sessionKey,
        sessionMtimeMs: 1,
      };
      if (e.pushed !== undefined) {
        state.pushed[harness] ??= {};
        state.pushed[harness]![e.rel] = {
          generation: e.pushedGen ?? 'g',
          size: e.pushed,
          chunks: [],
          chunksHash: 'm',
        };
      }
    }
  }
  return state;
}

describe('computeStatus', () => {
  it('按 harness 统计会话数与字节,四个工具都列出(空则 0)', () => {
    const state = stateWith({
      'claude-code': [
        { rel: 'projects/a.jsonl', sessionKey: 'a', size: 100, pushed: 100 },
        { rel: 'projects/b.jsonl', sessionKey: 'b', size: 50, pushed: 50 },
        { rel: 'transcripts/c.jsonl', sessionKey: 'c', size: 25 },
      ],
      doubao: [{ rel: '.sessions/s1/board.md', sessionKey: 's1', size: 10 }],
    });

    const r = computeStatus({ state, deviceId: 'dev1', deviceName: '本机', adapters });

    expect(r.harnesses.map((h) => h.id)).toEqual(['claude-code', 'codex', 'opencode', 'doubao']);
    const cc = r.harnesses.find((h) => h.id === 'claude-code')!;
    expect(cc.sessionCount).toBe(3);
    expect(cc.bytes).toBe(175);
    expect(r.harnesses.find((h) => h.id === 'codex')!.sessionCount).toBe(0);
  });

  it('待同步 = 未推送 / 大小不一致 / 世代变化,按 harness 分会话与文件', () => {
    const state = stateWith({
      'claude-code': [
        { rel: 'projects/a.jsonl', sessionKey: 'a', size: 100, pushed: 100 },
        { rel: 'projects/b.jsonl', sessionKey: 'b', size: 50 },
      ],
      codex: [{ rel: 'sessions/c.jsonl', sessionKey: 'c', size: 30, pushed: 10 }],
    });

    const r = computeStatus({ state, deviceId: 'dev1', deviceName: '本机', adapters });

    expect(r.pending).toEqual({
      sessions: 2,
      files: 2,
      bytes: 80,
      byHarness: [
        { id: 'claude-code', displayName: 'Claude Code', sessions: 1, files: 1, bytes: 50 },
        { id: 'codex', displayName: 'Codex', sessions: 1, files: 1, bytes: 30 },
      ],
    });
  });

  it('同尺寸但世代变化算待同步;同会话多文件只算 1 个会话', () => {
    const state = stateWith({
      'claude-code': [
        { rel: 'projects/a.jsonl', sessionKey: 'a', size: 100, pushed: 100, pushedGen: 'old' },
        { rel: 'transcripts/a.jsonl', sessionKey: 'a', size: 20 },
      ],
    });

    const r = computeStatus({ state, deviceId: 'dev1', deviceName: '本机', adapters });

    expect(r.pending.sessions).toBe(1);
    expect(r.pending.files).toBe(2);
    expect(r.pending.bytes).toBe(120);
    expect(r.harnesses.find((h) => h.id === 'claude-code')!.sessionCount).toBe(1);
  });
});

describe('computeLibraryPending', () => {
  it('按 sessions / skills / index 分类统计待推送文件', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-status-'));
    const files = [
      'sessions/claude-code/sess1/dev1.jsonl',
      'skills/review/versions/hash/SKILL.md',
      'index/dev1.json',
    ];
    for (const rel of files) {
      await mkdir(join(vault, 'library', ...rel.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(vault, 'library', ...rel.split('/')), 'x'.repeat(5));
    }
    const state = emptyState();

    const r = await computeLibraryPending(vault, state);

    expect(r).toEqual({
      sessions: { count: 1, files: 1, bytes: 5 },
      skills: { count: 1, files: 1, bytes: 5 },
      index: { files: 1, bytes: 5 },
    });

    // 已推送且 size + mtime 一致 → 不再计入
    for (const rel of files) {
      const st = await stat(join(vault, 'library', ...rel.split('/')));
      state.library.pushed[rel] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    }
    expect(await computeLibraryPending(vault, state)).toEqual({
      sessions: { count: 0, files: 0, bytes: 0 },
      skills: { count: 0, files: 0, bytes: 0 },
      index: { files: 0, bytes: 0 },
    });
  });
});

describe('probeRemote', () => {
  it('从 library/index 列设备,读 meta.json 补名字与在线时间', async () => {
    const remote = new MemoryRemote();
    await remote.writeJson('library/index/dev1.json', { v: 1 });
    await remote.writeJson('library/index/dev2.json', { v: 1 });
    await remote.writeJson('raw/dev2/meta.json', { id: 'dev2', name: '另一台', lastSeen: 500 });

    const got = await probeRemote(remote, AbortSignal.timeout(5000));

    expect(got.ok).toBe(true);
    expect(got.devices).toEqual([
      { id: 'dev1', name: 'dev1' },
      { id: 'dev2', name: '另一台', lastSeen: 500 },
    ]);
  });

  it('远端异常时降级为不可达,不抛出', async () => {
    const bad = {
      list: async () => {
        throw new Error('boom');
      },
    } as unknown as MemoryRemote;

    const got = await probeRemote(bad, AbortSignal.timeout(5000));

    expect(got.ok).toBe(false);
    expect(got.error).toContain('boom');
    expect(got.devices).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { computeOtherDevices, computeStatus } from '../src/status.js';
import { emptyState } from '../src/core/state.js';
import { claudeCodeAdapter, codexAdapter, doubaoAdapter, opencodeAdapter } from '../src/adapters/index.js';

const adapters = [
  claudeCodeAdapter('/tmp/x/.claude'),
  codexAdapter('/tmp/x/.codex'),
  opencodeAdapter('/tmp/x/opencode.db'),
  doubaoAdapter('/tmp/x/ws'),
];

function stateWith(
  entries: Record<string, Array<{ rel: string; sessionKey: string; size: number; pushed?: number }>>,
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
          generation: 'g',
          size: e.pushed,
          chunks: [],
          manifestHash: 'm',
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

  it('待同步 = 未推送或大小不一致的条目', () => {
    const state = stateWith({
      'claude-code': [
        { rel: 'projects/a.jsonl', sessionKey: 'a', size: 100, pushed: 100 },
        { rel: 'projects/b.jsonl', sessionKey: 'b', size: 50 },
      ],
      codex: [{ rel: 'sessions/c.jsonl', sessionKey: 'c', size: 30, pushed: 10 }],
    });

    const r = computeStatus({ state, deviceId: 'dev1', deviceName: '本机', adapters });

    expect(r.pendingCount).toBe(2);
    expect(r.pendingBytes).toBe(80);
    expect(r.sessionTotal).toBe(3);
    expect(r.bytesTotal).toBe(180);
  });

});

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('computeOtherDevices', () => {
  it('统计其他设备会话数与字节,名字取 meta.json', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-status-'));
    const dir = join(vault, 'raw/dev2/claude-code/projects');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.jsonl'), 'aaa');
    await writeFile(join(dir, 'b.jsonl'), 'bb');
    await mkdir(join(vault, 'raw/dev2'), { recursive: true });
    await writeFile(
      join(vault, 'raw/dev2/meta.json'),
      JSON.stringify({ id: 'dev2', name: '另一台', lastSeen: 1 }),
    );

    const got = await computeOtherDevices(vault, 'dev1', adapters);
    expect(got).toEqual([{ id: 'dev2', name: '另一台', sessionCount: 2, bytes: 5 }]);
  });

});

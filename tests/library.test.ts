import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildLibrary } from '../src/core/library/build.js';
import { rebuildUnifiedIndex, loadLibraryIndex } from '../src/core/library/index-file.js';
import { emptyState } from '../src/core/state.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

export function claudeMain(sessionId: string, text = '第一问'): string {
  return (
    [
      { type: 'last-prompt', leafUuid: 'a1', sessionId },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        timestamp: '2026-10-22T13:00:00.000Z',
        cwd: '/w',
        message: { role: 'user', content: text },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId,
        timestamp: '2026-10-22T13:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '主回答' }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

export function claudeSubagent(sessionId: string, agentId: string, spawnUuid: string): string {
  return (
    [
      {
        type: 'user',
        uuid: 's1',
        parentUuid: spawnUuid,
        isSidechain: true,
        agentId,
        sessionId,
        timestamp: '2026-10-22T13:00:02.000Z',
        message: { role: 'user', content: '子代理任务' },
      },
      {
        type: 'assistant',
        uuid: 's2',
        parentUuid: 's1',
        isSidechain: true,
        agentId,
        sessionId,
        timestamp: '2026-10-22T13:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '子代理结论' }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

async function seedClaudeSession(vault: string, device: string, sessionId: string): Promise<void> {
  const dir = join(vault, 'raw', device, 'claude-code/projects/-proj', sessionId, 'subagents');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(vault, 'raw', device, 'claude-code/projects/-proj', `${sessionId}.jsonl`),
    claudeMain(sessionId),
  );
  await writeFile(join(dir, 'agent-a1.jsonl'), claudeSubagent(sessionId, 'agent-a1', 'a1'));
}

describe('library:按会话身份归组', () => {
  it('Claude 主文件与 subagents 合成一个会话,子代理消息带 thread', async () => {
    const vault = await tmp('trove-lib-');
    await seedClaudeSession(vault, 'dev1', 'ses_1');

    const r = await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state: emptyState() });
    expect(r.sessions).toBe(1);

    const index = await loadLibraryIndex(vault);
    expect(index).not.toBeNull();
    expect(Object.keys(index!.sessions)).toEqual(['claude-code:ses_1']);

    const merged = index!.sessions['claude-code:ses_1']!;
    expect(merged.canonical.events).toBe(5); // session 头 + 2 主消息 + 2 子代理消息

    const file = join(vault, 'library', merged.canonical.path);
    const events = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.text ?? e.kind)).toEqual([
      'session',
      '第一问',
      '主回答',
      '子代理任务',
      '子代理结论',
    ]);
    const sub = events.find((e) => e.text === '子代理结论');
    expect(sub.thread).toBe('agent-a1');
    expect(sub.raw.path).toBe('raw/dev1/claude-code/projects/-proj/ses_1/subagents/agent-a1.jsonl');
  });

  it('内容没变时不重写文件', async () => {
    const vault = await tmp('trove-lib-');
    await seedClaudeSession(vault, 'dev1', 'ses_1');
    const state = emptyState();
    await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state });

    const second = await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state });
    expect(second.written).toBe(0);
  });

  it('同一会话在两个设备内容不同时,索引标出 canonical 与 variants', async () => {
    const vault = await tmp('trove-lib-');
    await seedClaudeSession(vault, 'dev1', 'ses_1');
    await seedClaudeSession(vault, 'dev2', 'ses_1');
    // 设备 B 多一条消息 → 内容不同
    await writeFile(
      join(vault, 'raw/dev2/claude-code/projects/-proj/ses_1.jsonl'),
      claudeMain('ses_1') +
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId: 'ses_1',
          timestamp: '2026-10-22T13:00:04.000Z',
          message: { role: 'user', content: '追加问题' },
        }) +
        '\n' +
        JSON.stringify({ type: 'last-prompt', leafUuid: 'u2', sessionId: 'ses_1' }) +
        '\n',
    );

    await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state: emptyState() });
    await buildLibrary({ vaultRoot: vault, deviceId: 'dev2', state: emptyState() });
    const index = await rebuildUnifiedIndex(vault);

    const merged = index.sessions['claude-code:ses_1']!;
    expect(merged.canonical.device).toBe('dev2'); // 事件更多
    expect(merged.variants.map((v) => v.device)).toEqual(['dev1']);
    expect(merged.sources.sort()).toEqual(['dev1', 'dev2']);
  });

  it('豆包两台设备各有一半时,canonical 是事件并集', async () => {
    const vault = await tmp('trove-lib-');
    for (const [device, text] of [
      ['dev1', '设备一的问题'],
      ['dev2', '设备二的问题'],
    ] as const) {
      const dir = join(vault, `raw/${device}/doubao/.sessions/123/agents/a1/system`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'assignment.md'),
        `# Assignment\n\n## [2026-10-20T02:31:10Z] 需求\n${text}\n`,
      );
    }

    await buildLibrary({ vaultRoot: vault, deviceId: 'dev1', state: emptyState() });
    await buildLibrary({ vaultRoot: vault, deviceId: 'dev2', state: emptyState() });
    const index = await rebuildUnifiedIndex(vault);

    const merged = index.sessions['doubao:123']!;
    expect(merged.canonical.device).toBe('merged');
    const events = (
      await readFile(join(vault, 'library', merged.canonical.path), 'utf8')
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.text).filter(Boolean).sort()).toEqual([
      '设备一的问题',
      '设备二的问题',
    ]);
  });
});

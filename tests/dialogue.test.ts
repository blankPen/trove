import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { collect } from '../src/core/collect.js';
import { emptyState } from '../src/core/state.js';
import { listSessions } from '../src/core/sessions.js';
import { DatabaseSync } from '../src/sqlite.js';
import type { Adapter, FileAdapter } from '../src/adapters/index.js';
import { doubaoAdapter } from '../src/adapters/index.js';

export async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 只暴露 projects/**.jsonl 的 Claude 适配器(测试用,避免依赖真实 home)。 */
export function claudeAdapter(root: string): FileAdapter {
  return {
    kind: 'files',
    id: 'claude-code',
    displayName: 'Claude Code',
    source: {
      id: 'claude-code',
      displayName: 'Claude Code',
      root,
      patterns: ['projects/**/*.jsonl'],
      exclusions: [],
      sessionPatterns: ['projects/**/*.jsonl'],
    },
  };
}

export function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** 只暴露 sessions/**.jsonl 的 Codex 适配器。 */
export function codexAdapter(root: string): FileAdapter {
  return {
    kind: 'files',
    id: 'codex',
    displayName: 'Codex',
    source: {
      id: 'codex',
      displayName: 'Codex',
      root,
      patterns: ['sessions/**/*.jsonl'],
      exclusions: [],
      sessionPatterns: ['sessions/**/*.jsonl'],
    },
  };
}

describe('对话层:collect → sessions', () => {
  it('collect 后能列出一个 Claude 会话', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(
      join(src, 'projects/p1.jsonl'),
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:54.338Z',
          cwd: '/w',
          message: { role: 'user', content: '你好' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:55.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: '你好,有什么可以帮你' }],
          },
        },
      ]),
    );

    await collect({
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const sessions = await listSessions(vault);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      harness: 'claude-code',
      session: 's1',
      firstText: '你好',
      model: 'claude-opus-5',
    });
  });

  it('内容块映射为 message / reasoning / tool_call / tool_result,并回指 raw 行号', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(
      join(src, 'projects/p1.jsonl'),
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:54.338Z',
          cwd: '/w',
          message: { role: 'user', content: '看下这个文件' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:55.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 5,
              output_tokens_details: { thinking_tokens: 7 },
            },
            content: [
              { type: 'thinking', thinking: '先读文件' },
              { type: 'text', text: '我读一下' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Read',
                input: { file_path: '/w/a' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:56.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          sessionId: 's1',
          timestamp: '2026-10-22T13:12:57.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              },
            ],
          },
        },
      ]),
    );

    await collect({
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const [summary] = await listSessions(vault);
    const lines = (await readFile(summary!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(lines.map((e) => e.kind)).toEqual([
      'session',
      'message',
      'reasoning',
      'message',
      'tool_call',
      'tool_result',
      'message',
    ]);

    const call = lines.find((e) => e.kind === 'tool_call');
    expect(call.tool).toEqual({ name: 'Read', call_id: 'toolu_1', input: { file_path: '/w/a' } });
    expect(call.raw).toEqual({ path: 'raw/dev1/claude-code/projects/p1.jsonl', line: 2 });

    const result = lines.find((e) => e.kind === 'tool_result');
    expect(result.result).toMatchObject({ call_id: 'toolu_1', status: 'ok', output: '文件内容' });
    expect(result.raw).toEqual({ path: 'raw/dev1/claude-code/projects/p1.jsonl', line: 3 });

    const assistant = lines.filter((e) => e.kind === 'message' && e.role === 'assistant')[0];
    expect(assistant.usage).toEqual({
      input: 100,
      output: 20,
      cache_read: 40,
      cache_write: 5,
      reasoning: 7,
    });

    const image = lines[lines.length - 1];
    expect(image.parts).toEqual([{ type: 'image', mime: 'image/png' }]);
    expect(image.text).toBeUndefined();
    expect(JSON.stringify(image)).not.toContain('AAAA');
    expect(image.raw).toEqual({ path: 'raw/dev1/claude-code/projects/p1.jsonl', line: 4 });
  });

  it('按 leafUuid 还原活动分支,子代理消息带 thread', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    const records = [
      { type: 'last-prompt', leafUuid: 'a2', sessionId: 's1' },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:00.000Z',
        message: { role: 'user', content: '第一问' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '被放弃的回答' }] },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:02.000Z',
        message: { role: 'user', content: '重来' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '当前回答' }] },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'a2',
        isSidechain: true,
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '子代理的结论' }] },
      },
    ];
    await writeFile(join(src, 'projects/p1.jsonl'), jsonl(records));

    await collect({
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const [summary] = await listSessions(vault);
    const events = (await readFile(summary!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const texts = events.filter((e) => e.kind === 'message').map((e) => e.text);

    expect(texts).toEqual(['第一问', '重来', '当前回答', '子代理的结论']);
    expect(texts).not.toContain('被放弃的回答');

    const side = events.find((e) => e.text === '子代理的结论');
    expect(side.thread).toBe('a3');

    // 被放弃的分支仍完整保留在 raw 里,可通过 raw 回查
    const raw = await readFile(
      join(vault, 'raw/dev1/claude-code/projects/p1.jsonl'),
      'utf8',
    );
    expect(raw).toContain('被放弃的回答');
  });

  it('多个 last-prompt 时取最后一个叶子,不走已被覆盖的旧分支', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(
      join(src, 'projects/p1.jsonl'),
      jsonl([
        { type: 'last-prompt', leafUuid: 'a1', sessionId: 's1' }, // 旧的叶子
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: 's1',
          timestamp: '2026-10-22T13:00:00.000Z',
          message: { role: 'user', content: '第一问' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 's1',
          timestamp: '2026-10-22T13:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
        },
        {
          type: 'user',
          uuid: 'u2',
          parentUuid: 'u1',
          sessionId: 's1',
          timestamp: '2026-10-22T13:00:02.000Z',
          message: { role: 'user', content: '换个方向' },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          sessionId: 's1',
          timestamp: '2026-10-22T13:00:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '新回答' }] },
        },
        { type: 'last-prompt', leafUuid: 'a2', sessionId: 's1' }, // 最新叶子
      ]),
    );

    await collect({
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const [summary] = await listSessions(vault);
    const events = (await readFile(summary!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const texts = events.filter((e) => e.kind === 'message').map((e) => e.text);
    expect(texts).toEqual(['第一问', '换个方向', '新回答']);
  });

  it('transcripts  schema(user / tool_use / tool_result)也能映射', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'transcripts'), { recursive: true });
    await writeFile(
      join(src, 'transcripts/ses_abc.jsonl'),
      jsonl([
        {
          type: 'user',
          timestamp: '2026-08-13T16:01:17.355Z',
          content: '帮我查一下任务',
        },
        {
          type: 'tool_use',
          timestamp: '2026-08-13T16:01:55.925Z',
          tool_name: 'bash',
          tool_input: { command: 'task get 1' },
        },
        {
          type: 'tool_result',
          timestamp: '2026-08-13T16:01:57.176Z',
          tool_name: 'bash',
          tool_input: { command: 'task get 1' },
          tool_output: { output: '{"id":1}' },
        },
      ]),
    );

    const adapter = claudeAdapter(src);
    adapter.source.patterns = ['transcripts/**/*.jsonl'];
    adapter.source.sessionPatterns = ['transcripts/**/*.jsonl'];
    await collect({
      adapters: [adapter],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const [summary] = await listSessions(vault);
    expect(summary).toMatchObject({ harness: 'claude-code', session: 'ses_abc', firstText: '帮我查一下任务' });

    const events = (await readFile(summary!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'message',
      'tool_call',
      'tool_result',
    ]);
    expect(events[2].tool).toMatchObject({ name: 'bash', input: { command: 'task get 1' } });
    expect(events[3].result).toMatchObject({ output: '{"id":1}' });
  });

  it('只有 user 记录的 transcript 也要生成会话', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'transcripts'), { recursive: true });
    await writeFile(
      join(src, 'transcripts/ses_only_user.jsonl'),
      jsonl([
        { type: 'user', timestamp: '2026-08-13T16:00:00.000Z', content: '第一句' },
        { type: 'user', timestamp: '2026-08-13T16:00:05.000Z', content: '第二句' },
      ]),
    );
    const adapter = claudeAdapter(src);
    adapter.source.patterns = ['transcripts/**/*.jsonl'];
    adapter.source.sessionPatterns = ['transcripts/**/*.jsonl'];

    await collect({
      adapters: [adapter],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const sessions = await listSessions(vault);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ session: 'ses_only_user', firstText: '第一句' });
  });

  it('raw 追加时事件文件只追加新增部分', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    const first = {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: '2026-10-22T13:00:00.000Z',
      message: { role: 'user', content: '第一句' },
    };
    const second = {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 's1',
      timestamp: '2026-10-22T13:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '第二句' }] },
    };
    await writeFile(join(src, 'projects/p1.jsonl'), jsonl([first]));

    const state = emptyState();
    const o = {
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      cutoff: 0,
    };
    await collect(o);
    const [summary] = await listSessions(vault);
    const before = await readFile(summary!.path, 'utf8');

    await writeFile(join(src, 'projects/p1.jsonl'), jsonl([first, second]));
    await collect(o);

    const after = await readFile(summary!.path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split('\n')).toHaveLength(3);
  });

  it('事件文件被删掉后,下一轮自动重建', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'projects'), { recursive: true });
    await writeFile(
      join(src, 'projects/p1.jsonl'),
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: 's1',
          timestamp: '2026-10-22T13:00:00.000Z',
          message: { role: 'user', content: '你好' },
        },
      ]),
    );
    const state = emptyState();
    const o = {
      adapters: [claudeAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      cutoff: 0,
    };
    await collect(o);
    const [summary] = await listSessions(vault);
    const before = await readFile(summary!.path, 'utf8');

    await rm(summary!.path);
    await collect(o);

    expect(await readFile(summary!.path, 'utf8')).toBe(before);
  });

  it('Codex:session_meta 建头,response_item 映射消息/推理/工具,event_msg 去重', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    await mkdir(join(src, 'sessions/2026/10/22'), { recursive: true });
    await writeFile(
      join(src, 'sessions/2026/10/22/rollout-1.jsonl'),
      jsonl([
        {
          timestamp: '2026-10-22T13:00:00.000Z',
          ordinal: 1,
          type: 'session_meta',
          payload: { id: 's1', cwd: '/w', model_provider: 'openai' },
        },
        {
          timestamp: '2026-10-22T13:00:01.000Z',
          ordinal: 2,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '你好' }],
          },
        },
        {
          timestamp: '2026-10-22T13:00:02.000Z',
          ordinal: 3,
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ type: 'text', text: '想一想' }] },
        },
        {
          timestamp: '2026-10-22T13:00:03.000Z',
          ordinal: 4,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            call_id: 'c1',
            arguments: '{"cmd":"ls"}',
          },
        },
        {
          timestamp: '2026-10-22T13:00:04.000Z',
          ordinal: 5,
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
        },
        {
          timestamp: '2026-10-22T13:00:05.000Z',
          ordinal: 6,
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'UserMessage', content: [{ type: 'text', text: '你好' }] },
          },
        },
      ]),
    );

    await collect({
      adapters: [codexAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const [summary] = await listSessions(vault);
    expect(summary).toMatchObject({ harness: 'codex', session: 's1', firstText: '你好' });

    const events = (await readFile(summary!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'message',
      'reasoning',
      'tool_call',
      'tool_result',
    ]);
    expect(events[3].tool).toEqual({ name: 'shell', call_id: 'c1', input: { cmd: 'ls' } });
    expect(events[4].result).toMatchObject({ call_id: 'c1', output: 'a.txt' });
    expect(events[1].raw).toEqual({ path: 'raw/dev1/codex/sessions/2026/10/22/rollout-1.jsonl', line: 2 });
  });

  it('OpenCode:session_message 展开为 推理/文本/工具,旧表重复行不重复出事件', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    const db = new DatabaseSync(join(src, 'opencode.db'));
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
        fork_session_id TEXT, fork_boundary TEXT, slug TEXT, directory TEXT, path TEXT,
        title TEXT, version TEXT, share_url TEXT, summary_additions INTEGER,
        summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT,
        cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
        tokens_cache_write INTEGER DEFAULT 0, revert TEXT, permission TEXT, agent TEXT,
        model TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER,
        time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0,
        time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO session_v2 (id,project_id,slug,directory,title,version,model,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'ses_1',
      'p1',
      'slug',
      '/repo',
      'opencode 标题',
      '1.0',
      JSON.stringify({ id: 'glm-4.7', providerID: 'zhipuai' }),
      1000,
      3000,
    );
    const insMsg = db.prepare(
      'INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)',
    );
    insMsg.run(
      'msg_0',
      'ses_1',
      'user',
      0,
      1000,
      1000,
      JSON.stringify({ text: '帮我看看' }),
    );
    insMsg.run(
      'msg_1',
      'ses_1',
      'assistant',
      1,
      2000,
      2000,
      JSON.stringify({
        agent: 'Sisyphus',
        model: { id: 'glm-4.7', providerID: 'zhipuai' },
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        finish: 'stop',
        content: [
          { type: 'reasoning', text: '先看目录' },
          { type: 'text', text: '目录里有 a.ts' },
          {
            type: 'tool',
            id: 'call_1',
            name: 'glob',
            state: { status: 'completed', input: { pattern: '**/*' }, output: 'a.ts' },
          },
        ],
      }),
    );
    insMsg.run('msg_2', 'ses_1', 'synthetic', 2, 2100, 2100, JSON.stringify({ text: '[analyze]' }));
    db.prepare(
      'INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)',
    ).run('msg_1', 'ses_1', 2000, 2000, JSON.stringify({ role: 'assistant', cost: 0.01 }));
    db.prepare(
      'INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)',
    ).run('prt_1', 'msg_1', 'ses_1', 2000, 2000, JSON.stringify({ type: 'text', text: '旧序列化' }));
    db.close();

    const adapter: Adapter = { kind: 'opencode', id: 'opencode', displayName: 'OpenCode', dbPath: join(src, 'opencode.db') };
    await collect({
      adapters: [adapter],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const sessions = await listSessions(vault);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      harness: 'opencode',
      session: 'ses_1',
      title: 'opencode 标题',
      cwd: '/repo',
      model: 'glm-4.7',
    });

    const events = (await readFile(sessions[0]!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'message',
      'reasoning',
      'message',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(events.map((e) => e.text).filter(Boolean)).toEqual([
      '帮我看看',
      '先看目录',
      '目录里有 a.ts',
      '[analyze]',
    ]);
    expect(events.find((e) => e.kind === 'tool_call').tool).toEqual({
      name: 'glob',
      call_id: 'call_1',
      input: { pattern: '**/*' },
    });
    expect(events.find((e) => e.kind === 'tool_result').result).toMatchObject({
      call_id: 'call_1',
      output: 'a.ts',
    });
    expect(events[3].usage).toEqual({ input: 10, output: 5, reasoning: 2, cache_read: 1 });
    expect(events[events.length - 1].extra).toMatchObject({ synthetic: true });
  });

  it('豆包:assignment 的需求块成为 user 消息,trajectory 与 tool-results 也进入对话层', async () => {
    const src = await tmp('trove-ev-src-');
    const vault = await tmp('trove-ev-vault-');
    const sessionDir = join(src, '.sessions/3844/agents/m_1/system');
    await mkdir(join(sessionDir, 'tool-results'), { recursive: true });
    await writeFile(join(src, '.sessions/3844/board.md'), '# 任务公告板\n');
    await writeFile(
      join(sessionDir, 'assignment.md'),
      [
        '# Assignment',
        '- Agent ID: m_1',
        '',
        '## [2026-10-20T02:31:10Z] 需求',
        '调研一下这个库',
        '## [2026-10-20T02:46:56Z] 需求',
        '会不会有副作用',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(sessionDir, 'trajectory.jsonl'),
      jsonl([
        { role: 'user', content: '调研一下这个库' },
        { role: 'assistant', content: '核心原理是解决方案梯子' },
      ]),
    );
    await writeFile(
      join(sessionDir, 'tool-results/execute_defer_tool_abc.txt'),
      '命令输出内容',
    );

    await collect({
      adapters: [doubaoAdapter(src)],
      deviceId: 'dev1',
      vaultRoot: vault,
      state: emptyState(),
      cutoff: 0,
    });

    const sessions = await listSessions(vault);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      harness: 'doubao',
      session: '3844',
      firstText: '调研一下这个库',
    });

    const events = (await readFile(sessions[0]!.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events[0].kind).toBe('session');

    const userTexts = events.filter((e) => e.kind === 'message' && e.role === 'user').map((e) => e.text);
    expect(userTexts).toContain('调研一下这个库');
    expect(userTexts).toContain('会不会有副作用');
    expect(events.find((e) => e.text === '核心原理是解决方案梯子')).toMatchObject({
      role: 'assistant',
      thread: 'm_1',
    });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({
      result: { output: '命令输出内容' },
    });
    expect(events.find((e) => e.text === '会不会有副作用')!.ts).toBe('2026-10-20T02:46:56.000Z');
  });
});

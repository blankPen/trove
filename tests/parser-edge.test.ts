import { describe, it, expect } from 'vitest';
import { mapClaude } from '../src/core/events/claude.js';
import { mapCodex } from '../src/core/events/codex.js';
import { mapOpencode } from '../src/core/events/opencode.js';
import { mapDoubao } from '../src/core/events/doubao.js';
import { hasMapper, mapSession } from '../src/core/events/index.js';
import { compact, firstLine, isoTime, type MapperFile } from '../src/core/events/schema.js';

/**
 * 仓库里没有 src/parser;原始会话的解析(JSONL / 导出 JSONL → 事件流)在 src/core/events。
 * 这里补齐各 mapper 在坏行、缺字段、空输入等边界上的单测。
 */

/** 行可以是对象(JSON 序列化),也可以是原样字符串(造坏行/空行)。 */
function file(relPath: string, lines: Array<unknown>, extra: Partial<MapperFile> = {}): MapperFile {
  return {
    relPath,
    rawPath: `raw/dev1/${relPath}`,
    text: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    ...extra,
  };
}

const TS = '2026-10-22T13:00:00.000Z';

describe('events/schema 边界', () => {
  it('isoTime:数字与可解析字符串转 ISO,空值/非法输入返回空串', () => {
    expect(isoTime(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoTime(Date.parse(TS))).toBe(TS);
    expect(isoTime(TS)).toBe(TS);
    expect(isoTime('')).toBe('');
    expect(isoTime('   ')).toBe('');
    expect(isoTime('not-a-date')).toBe('');
    expect(isoTime(Number.NaN)).toBe('');
    expect(isoTime(null)).toBe('');
    expect(isoTime(undefined)).toBe('');
  });

  it('firstLine:折叠空白、超长截断加省略号、空白文本返回 undefined', () => {
    expect(firstLine('  第一行\n\n 第二行\t结尾 ')).toBe('第一行 第二行 结尾');
    expect(firstLine('')).toBeUndefined();
    expect(firstLine(' \n\t ')).toBeUndefined();
    expect(firstLine('x'.repeat(120))).toBe('x'.repeat(120));
    expect(firstLine('x'.repeat(121))).toBe(`${'x'.repeat(120)}…`);
  });

  it('compact:只剔除 undefined/null/空串,保留 0、false 与空数组', () => {
    expect(compact({ a: undefined, b: null, c: '', d: 0, e: false, f: [] })).toEqual({
      d: 0,
      e: false,
      f: [],
    });
  });

  it('mapSession:未知 harness 没有 mapper,返回空事件流', () => {
    expect(hasMapper('claude-code')).toBe(true);
    expect(hasMapper('unknown' as never)).toBe(false);
    expect(mapSession('unknown' as never, [file('a.jsonl', [])])).toEqual([]);
  });
});

describe('mapClaude 边界', () => {
  const user = (over: Record<string, unknown> = {}) => ({
    type: 'user',
    uuid: 'u1',
    sessionId: 's1',
    timestamp: TS,
    message: { role: 'user', content: '第一句' },
    ...over,
  });
  const assistant = (over: Record<string, unknown> = {}) => ({
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    sessionId: 's1',
    timestamp: TS,
    message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    ...over,
  });

  it('坏行与空行跳过,后续行号仍按原文件计算', () => {
    const events = mapClaude([
      file('projects/a.jsonl', [
        user(),
        '{"type":"user","uuid":"broken',
        '',
        assistant(),
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'message']);
    expect(events[1]!.raw).toEqual({ path: 'raw/dev1/projects/a.jsonl', line: 1 });
    expect(events[2]!.raw).toEqual({ path: 'raw/dev1/projects/a.jsonl', line: 4 });
  });

  it('内容块里的非对象、未知类型、缺 text 的块都被忽略', () => {
    const events = mapClaude([
      file('projects/a.jsonl', [
        user({
          message: {
            role: 'user',
            content: [null, 'raw-string', { type: 'text' }, { type: 'mystery' }, { type: 'text', text: '保留' }],
          },
        }),
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message']);
    expect(events[1]!.text).toBe('保留');
  });

  it('tool_result:错误状态保留,数组内容拼成文本', () => {
    const events = mapClaude([
      file('projects/a.jsonl', [
        user({
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                is_error: true,
                content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
              },
            ],
          },
        }),
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'tool_result']);
    expect(events[1]!.result).toEqual({ call_id: 't1', status: 'error', output: 'a\nb' });
  });

  it('没有 sessionId 或没有任何消息时不产生会话', () => {
    expect(mapClaude([file('projects/a.jsonl', [user({ sessionId: undefined })])])).toEqual([]);
    expect(mapClaude([file('projects/a.jsonl', [{ type: 'last-prompt', leafUuid: 'x' }])])).toEqual(
      [],
    );
    expect(mapClaude([])).toEqual([]);
  });

  it('last-prompt 指向不存在的叶子时退回全部消息,不静默丢数据', () => {
    const events = mapClaude([
      file('projects/a.jsonl', [
        user({ message: { role: 'user', content: '问 1' } }),
        assistant({ message: { role: 'assistant', content: [{ type: 'text', text: '答 1' }] } }),
        user({ uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: '问 2' } }),
        assistant({
          uuid: 'a2',
          parentUuid: 'u2',
          message: { role: 'assistant', content: [{ type: 'text', text: '答 2' }] },
        }),
        { type: 'last-prompt', leafUuid: 'ghost', sessionId: 's1' },
      ]),
    ]);

    expect(events.filter((e) => e.kind === 'message').map((e) => e.text)).toEqual([
      '问 1',
      '答 1',
      '问 2',
      '答 2',
    ]);
  });

  it('usage 全为 0 时丢弃,部分字段为 0 时只保留非零项', () => {
    const events = mapClaude([
      file('projects/a.jsonl', [
        user({
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '一' }],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
        assistant({
          uuid: 'a2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '二' }],
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
      ]),
    ]);

    const messages = events.filter((e) => e.kind === 'message');
    expect(messages[0]!.usage).toBeUndefined();
    expect(messages[1]!.usage).toEqual({ input: 5 });
  });

  it('子代理消息带 agentId 线程;文件级 thread 覆盖普通消息', () => {
    const sidechain = mapClaude([
      file('projects/a.jsonl', [
        user({ message: { role: 'user', content: '主问题' } }),
        assistant({
          uuid: 'a1',
          isSidechain: true,
          agentId: 'agent-7',
          message: { role: 'assistant', content: [{ type: 'text', text: '子回答' }] },
        }),
      ]),
    ]);
    expect(sidechain.find((e) => e.text === '子回答')!.thread).toBe('agent-7');

    const withFileThread = mapClaude([
      file('projects/a.jsonl', [user()], { thread: 'file-thread' }),
    ]);
    expect(withFileThread.find((e) => e.kind === 'message')!.thread).toBe('file-thread');
  });

  it('transcripts schema:无 user 也能映射工具链,对象输出取 output 字段', () => {
    const events = mapClaude([
      file('transcripts/ses_abc.jsonl', [
        { type: 'tool_use', timestamp: TS, tool_name: 'bash', tool_input: { command: 'ls' } },
        { type: 'tool_result', timestamp: TS, tool_output: { output: 'a.txt' } },
        { type: 'tool_result', timestamp: TS },
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'tool_call', 'tool_result', 'tool_result']);
    expect(events[0]!.session).toBe('ses_abc');
    expect(events[2]!.result).toMatchObject({ output: 'a.txt' });
    expect(events[3]!.result?.output).toBeUndefined();
  });

  it('transcript 只有 session 头(非字符串 content 不算用户消息)时整体丢弃', () => {
    expect(
      mapClaude([file('transcripts/ses_abc.jsonl', [{ type: 'user', content: { text: 'x' } }])]),
    ).toEqual([]);
  });
});

describe('mapCodex 边界', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    timestamp: TS,
    type: 'session_meta',
    payload: { id: 's1', cwd: '/w', ...over },
  });
  const item = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    timestamp: TS,
    type: 'response_item',
    payload,
    ...over,
  });
  const message = (role: string, text: string) =>
    item({ type: 'message', role, content: [{ type: 'input_text', text }] });

  it('坏行与运行态记录(response_item 之外)不产生事件', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [
        meta(),
        message('user', '你好'),
        '{"type":"response_item"',
        { type: 'world_state', payload: { mode: 'x' } },
        { type: 'event_msg', payload: { type: 'item_completed' } },
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message']);
    expect(events[1]!.raw).toEqual({ path: 'raw/dev1/sessions/rollout.jsonl', line: 2 });
  });

  it('developer 角色映射为 system,空文本消息不产生事件', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [
        meta(),
        message('developer', '规则'),
        item({ type: 'message', role: 'assistant', content: [] }),
        message('user', '你好'),
      ]),
    ]);

    const messages = events.filter((e) => e.kind === 'message');
    expect(messages.map((e) => e.role)).toEqual(['system', 'user']);
    expect(events[0]!.firstText).toBe('你好');
  });

  it('工具参数解析失败时原样保留,非字符串参数直接透传', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [
        meta(),
        message('user', '你好'),
        item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: 'not-json' }),
        item({ type: 'custom_tool_call', name: 'edit', call_id: 'c2', input: { path: 'a' } }),
      ]),
    ]);

    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls[0]!.tool?.input).toBe('not-json');
    expect(calls[1]!.tool?.input).toEqual({ path: 'a' });
  });

  it('function_call_output 的对象输出原样保留', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [
        meta(),
        message('user', '你好'),
        item({ type: 'function_call_output', call_id: 'c1', output: { stdout: 'ok' } }),
      ]),
    ]);

    expect(events.find((e) => e.kind === 'tool_result')!.result).toEqual({
      call_id: 'c1',
      status: 'ok',
      output: { stdout: 'ok' },
    });
  });

  it('未知 response_item 类型保留为 meta 并记录原生类型', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [meta(), message('user', '你好'), item({ type: 'web_search_call' })]),
    ]);

    const extra = events.find((e) => e.kind === 'meta');
    expect(extra!.extra).toEqual({ native_type: 'web_search_call' });
  });

  it('缺 session_meta 或没有任何 message 时不产生会话', () => {
    expect(mapCodex([file('sessions/rollout.jsonl', [message('user', '你好')])])).toEqual([]);
    expect(mapCodex([file('sessions/rollout.jsonl', [meta()])])).toEqual([]);
    expect(mapCodex([])).toEqual([]);
  });

  it('ordinal 是数字时直接用,不是数字时回退为整数序号', () => {
    const events = mapCodex([
      file('sessions/rollout.jsonl', [
        meta(),
        item({ type: 'message', role: 'user', content: [{ type: 'text', text: '一' }] }, { ordinal: 7 }),
        item(
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: '二' }] },
          { ordinal: 'x' },
        ),
      ]),
    ]);

    expect(events[1]!.seq).toBe(7);
    expect(Number.isInteger(events[2]!.seq)).toBe(true);
  });
});

describe('mapOpencode 边界', () => {
  const row = (table: string, value: Record<string, unknown>) => ({ v: 1, table, row: value });
  const session = (over: Record<string, unknown> = {}) =>
    row('session_v2', {
      id: 'ses_1',
      title: '标题',
      directory: '/w',
      time_created: 1000,
      model: { id: 'glm-4.7' },
      ...over,
    });
  const message = (over: Record<string, unknown> = {}) =>
    row('session_message', {
      id: 'msg_1',
      session_id: 'ses_1',
      type: 'user',
      seq: 1,
      time_created: 2000,
      data: { text: '你好' },
      ...over,
    });

  it('坏行跳过,后续行号不受影响', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        session(),
        '{"v":1,"table":"session_message"',
        message(),
        message({
          id: 'msg_2',
          seq: 2,
          type: 'assistant',
          data: { content: [{ type: 'text', text: '回答' }] },
        }),
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'message']);
    expect(events[1]!.raw).toEqual({ path: 'raw/dev1/opencode/ses_1.jsonl', line: 3 });
  });

  it('缺会话行或没有消息时不产生会话', () => {
    expect(mapOpencode([file('opencode/ses_1.jsonl', [message()])])).toEqual([]);
    expect(mapOpencode([file('opencode/ses_1.jsonl', [session()])])).toEqual([]);
    expect(mapOpencode([])).toEqual([]);
  });

  it('旧表 session 行可当会话头;model JSON 损坏时忽略模型', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        row('session', {
          id: 'ses_legacy',
          directory: '/w',
          time_created: 'not-a-time',
          model: '{"id":',
        }),
        message({ session_id: 'ses_legacy' }),
      ]),
    ]);

    expect(events[0]!.session).toBe('ses_legacy');
    expect(events[0]!.ts).toBeUndefined();
    expect(events[0]!.cwd).toBe('/w');
    expect(events[0]!.model).toBeUndefined();
  });

  it('assistant 内容块:非对象忽略,工具无输出不出 result,error 状态保留', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        session(),
        message({
          type: 'assistant',
          data: {
            content: [
              null,
              'raw',
              { type: 'text', text: '正文' },
              {
                type: 'tool',
                id: 't1',
                name: 'glob',
                state: {
                  status: 'error',
                  input: { pattern: '**/*' },
                  output: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }],
                },
              },
            ],
          },
        }),
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'tool_call', 'tool_result']);
    expect(events[1]!.text).toBe('正文');
    expect(events[2]!.tool).toEqual({ name: 'glob', call_id: 't1', input: { pattern: '**/*' } });
    expect(events[3]!.result).toEqual({ call_id: 't1', status: 'error', output: 'x\ny' });
  });

  it('工具输出对象转 JSON,空字符串不产生 result', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        session(),
        message({
          type: 'assistant',
          data: {
            content: [
              { type: 'tool', id: 't1', name: 'a', state: { output: { a: 1 } } },
              { type: 'tool', id: 't2', name: 'b', state: { output: '' } },
            ],
          },
        }),
      ]),
    ]);

    const results = events.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.result?.output).toBe('{"a":1}');
  });

  it('usage 全零丢弃,部分为零只保留非零项;消息级 model 覆盖会话级', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        session(),
        message({
          data: {
            text: '你好',
            tokens: { input: 0, output: 3, cache: { read: 0, write: 2 } },
            model: { id: 'm2' },
          },
        }),
      ]),
    ]);

    expect(events[1]!.usage).toEqual({ output: 3, cache_write: 2 });
    expect(events[1]!.model).toEqual({ id: 'm2' });
  });

  it('seq 缺失时回退为当前事件数,未知消息类型记为 meta', () => {
    const events = mapOpencode([
      file('opencode/ses_1.jsonl', [
        session(),
        message({ seq: undefined }),
        message({ id: 'msg_2', seq: undefined, type: 'weird' }),
      ]),
    ]);

    expect(events[1]!.seq).toBe(1);
    expect(events[2]!.seq).toBe(2);
    expect(events[2]!.kind).toBe('meta');
    expect(events[2]!.extra).toEqual({ native_type: 'weird' });
  });
});

describe('mapDoubao 边界', () => {
  it('conversation/ 路径识别会话;CRLF 与空白需求块正常处理', () => {
    const events = mapDoubao([
      file('conversation/c9/assignment.md', [
        '## [2026-10-20T02:00:00Z] 需求\r',
        '第一问\r',
        '\r',
        '## [2026-10-20T02:10:00Z] 需求\r',
        '   \r',
        '## [2026-10-20T02:20:00Z] 需求\r',
        '第二问\r',
      ]),
    ]);

    const messages = events.filter((e) => e.kind === 'message');
    expect(events[0]!.session).toBe('c9');
    expect(events[0]!.title).toBe('第一问');
    expect(messages.map((e) => e.text)).toEqual(['第一问', '第二问']);
    expect(messages[1]!.ts).toBe('2026-10-20T02:20:00.000Z');
  });

  it('trajectory:坏行、非对象、空文本跳过;时间戳留空并标 ts_derived', () => {
    const events = mapDoubao([
      file('conversation/c9/agents/m1/trajectory.jsonl', [
        { role: 'user', content: '问' },
        '{"role":"assistant"',
        '',
        { role: 'assistant', content: '   ' },
        { role: 'assistant' },
        'null',
        { role: 'assistant', content: '答' },
      ]),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'message']);
    expect(events[1]).toMatchObject({ role: 'user', text: '问', thread: 'm1' });
    expect(events[1]!.ts).toBeUndefined();
    expect(events[1]!.extra).toEqual({ ts_derived: true });
    expect(events[2]).toMatchObject({ role: 'assistant', text: '答', thread: 'm1' });
  });

  it('tool-results:空白文件跳过,非空文件映射为 tool_result 并保留文件名', () => {
    const events = mapDoubao([
      file('conversation/c9/agents/m1/tool-results/empty.txt', ['   ']),
      file('conversation/c9/agents/m1/tool-results/run_1.txt', ['输出']),
    ]);

    expect(events.map((e) => e.kind)).toEqual(['session', 'tool_result']);
    expect(events[1]).toMatchObject({
      result: { status: 'ok', output: '输出' },
      thread: 'm1',
    });
    expect(events[1]!.extra).toEqual({ native_file: 'run_1.txt' });
  });

  it('认不出会话路径或只有 board/memory 时不产生会话', () => {
    expect(mapDoubao([file('misc/a.md', ['hello'])])).toEqual([]);
    expect(mapDoubao([file('.sessions/3844/board.md', ['# 公告板'])])).toEqual([]);
    expect(mapDoubao([])).toEqual([]);
  });
});

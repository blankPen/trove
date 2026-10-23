import type { Event, EventUsage, MapperFile } from './schema.js';
import { compact, firstLine, isoTime } from './schema.js';

export type { MapperFile } from './schema.js';

interface ParsedLine {
  file: MapperFile;
  line: number;
  o: Record<string, unknown>;
}

/** 从 message.content 里取纯文本(字符串或 text 块),用于标题与列表摘要。 */
function textOf(o: Record<string, unknown>): string {
  const message = o['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n');
}

/**
 * Claude Code:一行一条记录,`message.content` 是字符串或内容块数组。
 * 会话头取第一条消息的 sessionId/cwd/时间,首条 user 文本作为标题摘要。
 */
export function mapClaude(files: MapperFile[]): Event[] {
  const lines: ParsedLine[] = [];
  for (const file of files) {
    const parts = file.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      if (!raw.trim()) continue;
      try {
        lines.push({ file, line: i + 1, o: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        // 半行或损坏行:raw 里仍完整,事件层跳过
      }
    }
  }

  // transcripts/ 下是另一种 schema(user / tool_use / tool_result,无 message 字段)
  const transcriptLike = lines.some((l) =>
    ['user', 'tool_use', 'tool_result'].includes(String(l.o['type'])),
  );
  if (!lines.some((l) => l.o['message'] !== undefined) && transcriptLike) {
    return mapClaudeTranscript(files, lines);
  }

  const sessionId = lines.find((l) => l.o['sessionId'])?.o['sessionId'];
  const session = String(sessionId ?? '');
  const cwd = lines.find((l) => l.o['cwd'])?.['o']['cwd'] as string | undefined;
  const allMessages = lines.filter((l) => {
    const t = l.o['type'];
    return t === 'user' || t === 'assistant';
  });

  // 活动分支:取**最后一个** last-prompt 的叶子(每次提问都会追加一条,前面的已过期),
  // 再沿 parentUuid 回溯;没有则保留全部。
  const byUuid = new Map<string, ParsedLine>();
  for (const l of lines) {
    const u = l.o['uuid'];
    if (typeof u === 'string') byUuid.set(u, l);
  }
  const lastPrompts = lines.filter(
    (l) => l.o['type'] === 'last-prompt' && typeof l.o['leafUuid'] === 'string',
  );
  const leaf =
    (lastPrompts[lastPrompts.length - 1]?.['o']['leafUuid'] as string | undefined) ??
    ([...allMessages].reverse().find((l) => typeof l.o['uuid'] === 'string')?.['o'][
      'uuid'
    ] as string | undefined);
  const active = new Set<string>();
  for (let id = leaf, guard = 0; id && guard < 100_000; guard++) {
    if (active.has(id)) break;
    active.add(id);
    const parent = byUuid.get(id)?.['o']['parentUuid'];
    id = typeof parent === 'string' ? parent : undefined;
  }
  const onActiveBranch = active.size
    ? allMessages.filter((l) => l.o['isSidechain'] || active.has(String(l.o['uuid'])))
    : allMessages;
  // 叶子指针失效时(格式变化)不做静默丢弃,退回全部消息
  const messages = onActiveBranch.length ? onActiveBranch : allMessages;

  /** 子代理链根:向上找连续 isSidechain 的最顶端 uuid。 */
  const threadOf = (line: ParsedLine): string => {
    let cur = line;
    let root = String(cur.o['uuid'] ?? '');
    for (let i = 0; i < 100_000; i++) {
      const parentId = cur.o['parentUuid'];
      const parent = typeof parentId === 'string' ? byUuid.get(parentId) : undefined;
      if (!parent || !parent.o['isSidechain']) break;
      root = String(parent.o['uuid'] ?? root);
      cur = parent;
    }
    return root;
  };

  const firstUser = messages.find((l) => l.o['type'] === 'user' && textOf(l.o));
  const model = messages
    .map((l) => (l.o['message'] as Record<string, unknown> | undefined)?.['model'])
    .find((m): m is string => typeof m === 'string');
  const firstTs = isoTime(messages[0]?.['o']['timestamp']);

  // 没有会话 id 或没有任何消息(例如损坏/伪装成 jsonl 的文件):不产生对话层
  if (!session || !messages.length) return [];

  const events: Event[] = [
    compact({
      v: 1 as const,
      ts: firstTs,
      seq: 0,
      harness: 'claude-code' as const,
      session,
      kind: 'session' as const,
      id: session,
      firstText: firstLine(firstUser ? textOf(firstUser.o) : undefined),
      startedAt: firstTs || undefined,
      cwd,
      model: model ? { id: model } : undefined,
      raw: firstUser ? { path: firstUser.file.rawPath, line: firstUser.line } : undefined,
    }),
  ];

  let seq = 1;
  for (const { file, line, o } of messages) {
    const message = (o['message'] as Record<string, unknown> | undefined) ?? {};
    const role = (message['role'] as string | undefined) ?? (o['type'] as string);
    const content = message['content'];
    const blocks: Array<Record<string, unknown>> =
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
          : [];
    const usage = usageOf(message);
    const model = message['model'] as string | undefined;
    const id = (message['id'] as string | undefined) ?? (o['uuid'] as string | undefined);
    const raw = { path: file.rawPath, line };

    for (const block of blocks) {
      const type = block['type'];
      const base = {
        v: 1 as const,
        ts: isoTime(o['timestamp']),
        seq: seq++,
        harness: 'claude-code' as const,
        session,
        role: role as Event['role'],
        model: model ? { id: model } : undefined,
        thread: o['isSidechain']
          ? ((o['agentId'] as string | undefined) ?? threadOf({ file, line, o }))
          : file.thread,
        raw,
      };

      if (type === 'text' && typeof block['text'] === 'string') {
        events.push(compact({ ...base, kind: 'message' as const, id, text: block['text'], usage }));
      } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
        events.push(compact({ ...base, kind: 'reasoning' as const, text: block['thinking'] }));
      } else if (type === 'tool_use') {
        events.push(
          compact({
            ...base,
            kind: 'tool_call' as const,
            id: block['id'] as string | undefined,
            usage,
            tool: {
              name: block['name'] as string | undefined,
              call_id: block['id'] as string | undefined,
              input: block['input'],
            },
          }),
        );
      } else if (type === 'tool_result') {
        events.push(
          compact({
            ...base,
            kind: 'tool_result' as const,
            role: 'tool' as const,
            id: block['tool_use_id'] as string | undefined,
            result: {
              call_id: block['tool_use_id'] as string | undefined,
              status: block['is_error'] ? ('error' as const) : ('ok' as const),
              output: flatten(block['content']),
            },
          }),
        );
      } else if (type === 'image') {
        const source = (block['source'] as Record<string, unknown> | undefined) ?? {};
        events.push(
          compact({
            ...base,
            kind: 'message' as const,
            id,
            parts: [
              {
                type: 'image',
                mime: source['media_type'] as string | undefined,
              },
            ],
            // 图片二进制只在 raw 里;事件保留类型引用,UI 凭 raw 回查
          }),
        );
      }
    }
  }

  return events;
}

/** tool_result 的 content 可能是字符串或文本块数组。 */
function flatten(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n');
  return text || undefined;
}

/** message.usage → 统一 usage(只保留非零字段)。 */
function usageOf(message: Record<string, unknown>): EventUsage | undefined {
  const u = message['usage'] as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const details = u['output_tokens_details'] as Record<string, unknown> | undefined;
  const usage = compact({
    input: u['input_tokens'] as number | undefined,
    output: u['output_tokens'] as number | undefined,
    cache_read: u['cache_read_input_tokens'] as number | undefined,
    cache_write: u['cache_creation_input_tokens'] as number | undefined,
    reasoning: details?.['thinking_tokens'] as number | undefined,
  });
  for (const k of Object.keys(usage) as Array<keyof typeof usage>) {
    if (!usage[k]) delete usage[k];
  }
  return Object.keys(usage).length ? usage : undefined;
}

/**
 * transcripts/**:{type: user|tool_use|tool_result, timestamp, content?, tool_name?, tool_input?, tool_output?}
 * 没有 sessionId(用文件名当会话 id),也没有 assistant 文本,能映射的是用户输入与工具链。
 */
function mapClaudeTranscript(files: MapperFile[], lines: ParsedLine[]): Event[] {
  const first = files[0];
  if (!first) return [];
  const session = (first.relPath.split('/').pop() ?? '').replace(/\.jsonl$/, '');
  if (!session) return [];
  const firstUser = lines.find(
    (l) => l.o['type'] === 'user' && typeof l.o['content'] === 'string' && l.o['content'].trim(),
  );
  const startedAt = isoTime(firstUser?.['o']['timestamp'] ?? lines[0]?.['o']['timestamp']);

  const events: Event[] = [
    compact({
      v: 1 as const,
      ts: startedAt,
      seq: 0,
      harness: 'claude-code' as const,
      session,
      kind: 'session' as const,
      id: session,
      firstText: firstLine(firstUser?.['o']['content'] as string | undefined),
      startedAt: startedAt || undefined,
      raw: firstUser ? { path: firstUser.file.rawPath, line: firstUser.line } : undefined,
    }),
  ];

  let seq = 1;
  for (const { file, line, o } of lines) {
    const ts = isoTime(o['timestamp']);
    const raw = { path: file.rawPath, line };
    const base = { v: 1 as const, ts, seq: seq++, harness: 'claude-code' as const, session, raw };
    if (o['type'] === 'user' && typeof o['content'] === 'string' && o['content'].trim()) {
      events.push(
        compact({ ...base, kind: 'message' as const, role: 'user' as const, text: o['content'] as string }),
      );
    } else if (o['type'] === 'tool_use') {
      events.push(
        compact({
          ...base,
          kind: 'tool_call' as const,
          role: 'assistant' as const,
          tool: {
            name: o['tool_name'] as string | undefined,
            input: o['tool_input'],
          },
        }),
      );
    } else if (o['type'] === 'tool_result') {
      const out = o['tool_output'];
      const output =
        typeof out === 'string'
          ? out
          : out && typeof out === 'object' && typeof (out as Record<string, unknown>)['output'] === 'string'
            ? ((out as Record<string, unknown>)['output'] as string)
            : out === undefined
              ? undefined
              : JSON.stringify(out);
      events.push(
        compact({
          ...base,
          kind: 'tool_result' as const,
          role: 'tool' as const,
          result: { status: 'ok' as const, output },
        }),
      );
    }
  }

  return events.length > 1 ? events : [];
}

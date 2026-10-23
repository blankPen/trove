import type { Event, MapperFile } from './schema.js';
import { compact, firstLine, isoTime } from './schema.js';

interface ParsedLine {
  file: MapperFile;
  line: number;
  o: Record<string, unknown>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Codex 的文本都在 content / summary 数组里,元素形如 {type:'input_text', text}。 */
function textOf(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(isObj)
    .map((b) => (typeof b['text'] === 'string' ? (b['text'] as string) : ''))
    .filter(Boolean)
    .join('\n');
}

/** function_call 的 arguments 是 JSON 字符串;解析失败就原样保留。 */
function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function ordinalOf(o: Record<string, unknown>, fallback: number): number {
  const ordinal = o['ordinal'];
  return typeof ordinal === 'number' ? ordinal : fallback;
}

/**
 * Codex:rollout JSONL。`response_item` 是对话正文,`event_msg` 是它的重复副本,
 * `world_state`/`turn_context`/`token_usage_record` 是运行态——对话层只映射前者。
 */
export function mapCodex(files: MapperFile[]): Event[] {
  const lines: ParsedLine[] = [];
  for (const file of files) {
    const parts = file.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      if (!raw.trim()) continue;
      try {
        lines.push({ file, line: i + 1, o: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        // 损坏行跳过,raw 里仍在
      }
    }
  }

  const payloadOf = (l: ParsedLine): Record<string, unknown> =>
    isObj(l.o['payload']) ? l.o['payload'] : {};
  const meta = lines.find((l) => l.o['type'] === 'session_meta');
  const turnContext = lines.find((l) => l.o['type'] === 'turn_context');
  const metaPayload = meta ? payloadOf(meta) : {};
  const contextPayload = turnContext ? payloadOf(turnContext) : {};
  const session = String(metaPayload['id'] ?? '');
  const cwd = (metaPayload['cwd'] ?? contextPayload['cwd']) as string | undefined;
  const model = contextPayload['model'] as string | undefined;

  const messages = lines.filter((l) => {
    const p = payloadOf(l);
    return l.o['type'] === 'response_item' && p['type'] === 'message';
  });
  const firstUser = messages.find((l) => payloadOf(l)['role'] === 'user');
  const firstTs = isoTime(messages[0]?.['o']['timestamp'] ?? meta?.['o']['timestamp']);

  // 没有 session_meta 或没有对话:不产生对话层
  if (!session || !messages.length) return [];

  const events: Event[] = [
    compact({
      v: 1 as const,
      ts: firstTs,
      seq: 0,
      harness: 'codex' as const,
      session,
      kind: 'session' as const,
      id: session,
      firstText: firstLine(firstUser ? textOf(payloadOf(firstUser)['content']) : undefined),
      startedAt: firstTs || undefined,
      cwd,
      model: model ? { id: model } : undefined,
      raw: meta ? { path: meta.file.rawPath, line: meta.line } : undefined,
    }),
  ];

  let counter = 1;
  for (const parsed of lines) {
    const { file, line, o } = parsed;
    const payload = payloadOf(parsed);
    const raw = { path: file.rawPath, line };
    const base = {
      v: 1 as const,
      ts: isoTime(o['timestamp']),
      seq: ordinalOf(o, counter++),
      harness: 'codex' as const,
      session: String((payload['session_id'] as string | undefined) ?? session),
      raw,
    };

    if (o['type'] !== 'response_item') continue;
    const type = payload['type'];
    if (type === 'message') {
      const role = payload['role'] === 'developer' ? 'system' : (payload['role'] as string);
      const text = textOf(payload['content']);
      if (text) {
        events.push(
          compact({ ...base, kind: 'message' as const, role: role as Event['role'], text, id: payload['id'] as string | undefined }),
        );
      }
    } else if (type === 'reasoning') {
      const text = textOf(payload['summary'] ?? payload['content']);
      if (text) events.push(compact({ ...base, kind: 'reasoning' as const, role: 'assistant' as const, text }));
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      events.push(
        compact({
          ...base,
          kind: 'tool_call' as const,
          role: 'assistant' as const,
          id: payload['call_id'] as string | undefined,
          tool: {
            name: payload['name'] as string | undefined,
            call_id: payload['call_id'] as string | undefined,
            input: parseArgs(payload['arguments'] ?? payload['input']),
          },
        }),
      );
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      events.push(
        compact({
          ...base,
          kind: 'tool_result' as const,
          role: 'tool' as const,
          id: payload['call_id'] as string | undefined,
          result: {
            call_id: payload['call_id'] as string | undefined,
            status: 'ok' as const,
            output: payload['output'],
          },
        }),
      );
    } else {
      events.push(
        compact({
          ...base,
          kind: 'meta' as const,
          extra: { native_type: type },
        }),
      );
    }
  }

  return events;
}

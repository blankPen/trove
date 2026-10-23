import type { Event, EventUsage, MapperFile } from './schema.js';
import { compact, firstLine, isoTime } from './schema.js';

interface ParsedLine {
  file: MapperFile;
  line: number;
  o: Record<string, unknown>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** OpenCode 的 model 列是 JSON 字符串(或对象),统一成 {id, provider}。 */
function parseModel(value: unknown): { id?: string; provider?: string } | undefined {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!isObj(raw)) return undefined;
  const id = raw['id'];
  const provider = raw['providerID'];
  if (typeof id !== 'string' && typeof provider !== 'string') return undefined;
  return compact({
    id: typeof id === 'string' ? id : undefined,
    provider: typeof provider === 'string' ? provider : undefined,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** tool.state.output 可能是字符串、数组或对象,统一成可读字符串。 */
function outputOf(state: Record<string, unknown>): string | undefined {
  const out = state['output'] ?? state['content'];
  if (typeof out === 'string') return out || undefined;
  if (Array.isArray(out)) {
    const text = out
      .filter(isObj)
      .map((b) => (typeof b['text'] === 'string' ? (b['text'] as string) : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  if (out !== undefined) return JSON.stringify(out);
  return undefined;
}

function usageOf(tokens: unknown): EventUsage | undefined {
  if (!isObj(tokens)) return undefined;
  const cache = isObj(tokens['cache']) ? tokens['cache'] : {};
  const usage = compact({
    input: typeof tokens['input'] === 'number' ? tokens['input'] : undefined,
    output: typeof tokens['output'] === 'number' ? tokens['output'] : undefined,
    reasoning: typeof tokens['reasoning'] === 'number' ? tokens['reasoning'] : undefined,
    cache_read: typeof cache['read'] === 'number' ? cache['read'] : undefined,
    cache_write: typeof cache['write'] === 'number' ? cache['write'] : undefined,
  });
  // 0 与缺失同义(计数器),只保留非零值
  for (const k of Object.keys(usage) as Array<keyof typeof usage>) {
    if (!usage[k]) delete usage[k];
  }
  return Object.keys(usage).length ? usage : undefined;
}

/**
 * OpenCode:trove 导出的逐会话 JSONL(一行一个数据库行)。
 * `session_message` 是权威对话,旧表 `message`/`part` 是第二套序列化——对话层不重复映射,
 * 需要的字段仍可从 raw 回查。
 */
export function mapOpencode(files: MapperFile[]): Event[] {
  const lines: ParsedLine[] = [];
  for (const file of files) {
    const parts = file.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      if (!raw.trim()) continue;
      const o = safeJson(raw);
      if (isObj(o)) lines.push({ file, line: i + 1, o });
    }
  }

  const rowOf = (l: ParsedLine): Record<string, unknown> =>
    isObj(l.o['row']) ? l.o['row'] : {};
  const sessionRow =
    lines.find((l) => l.o['table'] === 'session_v2') ?? lines.find((l) => l.o['table'] === 'session');
  const head = sessionRow ? rowOf(sessionRow) : {};
  const session = String(head['id'] ?? '');
  const messages = lines.filter((l) => l.o['table'] === 'session_message');
  const firstUser = messages.find((l) => rowOf(l)['type'] === 'user');
  const dataOf = (l: ParsedLine): Record<string, unknown> => {
    const d = rowOf(l)['data'];
    const parsed = typeof d === 'string' ? safeJson(d) : d;
    return isObj(parsed) ? parsed : {};
  };
  const firstText = firstUser ? (dataOf(firstUser)['text'] as string | undefined) : undefined;
  const startedAt = isoTime(head['time_created']);

  // 没有会话行或没有消息:不产生对话层
  if (!session || !messages.length) return [];

  const events: Event[] = [
    compact({
      v: 1 as const,
      ts: startedAt,
      seq: 0,
      harness: 'opencode' as const,
      session,
      kind: 'session' as const,
      id: session,
      title: head['title'] as string | undefined,
      firstText: firstLine(firstText),
      startedAt: startedAt || undefined,
      cwd: head['directory'] as string | undefined,
      model: parseModel(head['model']),
      raw: sessionRow ? { path: sessionRow.file.rawPath, line: sessionRow.line } : undefined,
    }),
  ];

  for (const parsed of messages) {
    const { file, line } = parsed;
    const row = rowOf(parsed);
    const data = dataOf(parsed);
    const kind = row['type'];
    const ts = isoTime(row['time_created']);
    const usage = usageOf(data['tokens']);
    const model = parseModel(data['model']);
    const base = {
      v: 1 as const,
      ts,
      seq: typeof row['seq'] === 'number' ? row['seq'] : events.length,
      harness: 'opencode' as const,
      session,
      model,
      usage,
      raw: { path: file.rawPath, line },
    };
    const id = row['id'] as string | undefined;

    if (kind === 'user') {
      events.push(compact({ ...base, kind: 'message' as const, role: 'user' as const, id, text: data['text'] as string | undefined }));
    } else if (kind === 'assistant') {
      for (const part of Array.isArray(data['content']) ? data['content'] : []) {
        if (!isObj(part)) continue;
        const type = part['type'];
        if (type === 'reasoning' && typeof part['text'] === 'string') {
          events.push(compact({ ...base, kind: 'reasoning' as const, role: 'assistant' as const, text: part['text'] }));
        } else if (type === 'text' && typeof part['text'] === 'string') {
          events.push(compact({ ...base, kind: 'message' as const, role: 'assistant' as const, id, text: part['text'] }));
        } else if (type === 'tool') {
          const state = isObj(part['state']) ? part['state'] : {};
          const callId = (part['id'] as string | undefined) ?? (part['callID'] as string | undefined);
          events.push(
            compact({
              ...base,
              kind: 'tool_call' as const,
              role: 'assistant' as const,
              id: callId,
              tool: { name: part['name'] as string | undefined, call_id: callId, input: state['input'] },
            }),
          );
          const output = outputOf(state);
          if (output !== undefined) {
            events.push(
              compact({
                ...base,
                kind: 'tool_result' as const,
                role: 'tool' as const,
                id: callId,
                result: {
                  call_id: callId,
                  status: state['status'] === 'error' ? ('error' as const) : ('ok' as const),
                  output,
                },
              }),
            );
          }
        }
      }
    } else if (kind === 'system' || kind === 'synthetic') {
      events.push(
        compact({
          ...base,
          kind: 'message' as const,
          role: 'system' as const,
          id,
          text: data['text'] as string | undefined,
          extra: kind === 'synthetic' ? { synthetic: true } : undefined,
        }),
      );
    } else {
      events.push(compact({ ...base, kind: 'meta' as const, id, extra: { native_type: kind } }));
    }
  }

  return events;
}

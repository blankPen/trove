import type { Event, MapperFile } from './schema.js';
import { compact, firstLine, isoTime } from './schema.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sessionIdOf(relPath: string): string {
  const m = /(?:^|\/)\.sessions\/([^/]+)\//.exec(relPath) ?? /^conversation\/([^/]+)\//.exec(relPath);
  return m?.[1] ?? '';
}

function agentOf(relPath: string): string | undefined {
  return /\/agents\/([^/]+)\//.exec(relPath)?.[1];
}

/** 解析 assignment.md:每个 `## [时间] 需求` 块是一条用户需求。 */
function assignmentBlocks(text: string): Array<{ ts: string; body: string; line: number }> {
  const out: Array<{ ts: string; body: string; line: number }> = [];
  let current: { ts: string; body: string[]; line: number } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n').trim();
    if (body) out.push({ ts: current.ts, body, line: current.line });
    current = null;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^## \[([^\]]+)\]\s*需求\s*$/.exec(line);
    if (m) {
      flush();
      current = { ts: m[1]!, body: [], line: i + 1 };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return out;
}

/**
 * 豆包:一个会话是一个目录。
 * - assignment.md 的需求块 → user 消息(带原始时间戳)
 * - trajectory.jsonl → 对话(源里无时间戳,ts 留空并标 ts_derived)
 * - tool-results/*.txt → tool_result(输出正文)
 * board/memory/socket 是协作上下文,不进对话层,raw 里可查。
 */
export function mapDoubao(files: MapperFile[]): Event[] {
  const session = files.length ? sessionIdOf(files[0]!.relPath) : '';
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const assignments = sorted.filter((f) => f.relPath.endsWith('/assignment.md'));
  const trajectories = sorted.filter((f) => f.relPath.endsWith('/trajectory.jsonl'));
  const toolResults = sorted.filter((f) => f.relPath.includes('/tool-results/'));

  const firstAssignment = assignments[0];
  const firstBlock = firstAssignment ? assignmentBlocks(firstAssignment.text)[0] : undefined;
  const startedAt = firstBlock ? isoTime(firstBlock.ts) : '';

  // 认不出会话(路径不匹配)或没有任何内容:不产生对话层
  if (
    !session ||
    (!assignments.length && !trajectories.length && !toolResults.length)
  ) {
    return [];
  }

  const events: Event[] = [
    compact({
      v: 1 as const,
      ts: startedAt,
      seq: 0,
      harness: 'doubao' as const,
      session,
      kind: 'session' as const,
      id: session,
      title: firstLine(firstBlock?.body),
      firstText: firstLine(firstBlock?.body),
      startedAt: startedAt || undefined,
      raw: firstAssignment
        ? { path: firstAssignment.rawPath, line: firstBlock?.line ?? 1 }
        : undefined,
    }),
  ];
  let seq = 1;

  for (const file of assignments) {
    const thread = agentOf(file.relPath);
    for (const block of assignmentBlocks(file.text)) {
      events.push(
        compact({
          v: 1 as const,
          ts: isoTime(block.ts),
          seq: seq++,
          harness: 'doubao' as const,
          session,
          kind: 'message' as const,
          role: 'user' as const,
          text: block.body,
          thread,
          raw: { path: file.rawPath, line: block.line },
        }),
      );
    }
  }

  for (const file of trajectories) {
    const thread = agentOf(file.relPath);
    const parts = file.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      if (!raw.trim()) continue;
      let o: unknown;
      try {
        o = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (!isObj(o)) continue;
      const content = o['content'];
      if (typeof content !== 'string' || !content.trim()) continue;
      events.push(
        compact({
          v: 1 as const,
          ts: '',
          seq: seq++,
          harness: 'doubao' as const,
          session,
          kind: 'message' as const,
          role: (o['role'] as string | undefined) as Event['role'],
          text: content,
          thread,
          // 源格式没有时间戳,顺序由文件行序决定
          extra: { ts_derived: true },
          raw: { path: file.rawPath, line: i + 1 },
        }),
      );
    }
  }

  for (const file of toolResults) {
    const text = file.text.trim();
    if (!text) continue;
    const name = file.relPath.split('/').pop() ?? '';
    events.push(
      compact({
        v: 1 as const,
        ts: '',
        seq: seq++,
        harness: 'doubao' as const,
        session,
        kind: 'tool_result' as const,
        role: 'tool' as const,
        result: { status: 'ok' as const, output: text },
        thread: agentOf(file.relPath),
        extra: { native_file: name },
        raw: { path: file.rawPath, line: 1 },
      }),
    );
  }

  return events;
}

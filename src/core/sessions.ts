import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Event } from './events/schema.js';
import { libraryDir } from './layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from './library/index-file.js';
import type { MergedSession } from './library/schema.js';

export interface SessionSummary {
  /** canonical 变体所属设备(并集时为 merged) */
  device: string;
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  /** canonical 事件文件绝对路径 */
  path: string;
  bytes: number;
  events: number;
  /** 其他内容不同的设备版本数 */
  variants: number;
  devices: string[];
}

export interface ListSessionsOptions {
  device?: string;
  harness?: string;
  /** 标题/摘要/目录/模型/正文的模糊匹配 */
  grep?: string;
}

function headerMatches(s: MergedSession, needle: string): boolean {
  return [s.title, s.firstText, s.cwd, s.model, s.session, s.harness]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(needle));
}

function eventMatches(e: Event, needle: string): boolean {
  const parts = [
    e.text,
    e.title,
    e.cwd,
    e.model?.id,
    e.tool?.name,
    e.tool?.input === undefined ? undefined : JSON.stringify(e.tool.input),
    typeof e.result?.output === 'string' ? e.result.output : undefined,
  ];
  return parts.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

/** 在 canonical 事件文件里找关键词;命中即停。 */
async function bodyMatches(path: string, needle: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        continue;
      }
      if (eventMatches(e, needle)) return true;
    }
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * 列出 library 里的会话(canonical 视图)。
 * 索引缺失时按分片重建;--grep 只读命中的 canonical 文件。
 */
export async function listSessions(
  vaultRoot: string,
  opts: ListSessionsOptions = {},
): Promise<SessionSummary[]> {
  const index = (await loadLibraryIndex(vaultRoot)) ?? (await rebuildUnifiedIndex(vaultRoot));
  const needle = opts.grep?.toLowerCase();
  const out: SessionSummary[] = [];

  for (const s of Object.values(index.sessions)) {
    if (opts.harness && s.harness !== opts.harness) continue;
    if (opts.device && !s.sources.includes(opts.device)) continue;
    if (needle && !headerMatches(s, needle)) {
      const path = join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
      if (!(await bodyMatches(path, needle))) continue;
    }
    const path = join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      // 索引指向的文件缺失:仍然列出,便于发现不一致
    }
    out.push({
      device: s.canonical.device,
      harness: s.harness,
      session: s.session,
      ...(s.title ? { title: s.title } : {}),
      ...(s.firstText ? { firstText: s.firstText } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      path,
      bytes,
      events: s.canonical.events,
      variants: s.variants.length,
      devices: s.sources,
    });
  }

  out.sort(
    (a, b) =>
      (b.startedAt ?? '').localeCompare(a.startedAt ?? '') ||
      a.harness.localeCompare(b.harness) ||
      a.session.localeCompare(b.session),
  );
  return out;
}

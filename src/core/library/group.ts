import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessId } from '../../adapters/index.js';
import { rawDeviceDir } from '../layout.js';

export interface RawSession {
  harness: HarnessId;
  sessionId: string;
  /** 相对 harness 目录的路径,主文件在前 */
  files: string[];
  /** 每个文件的线程归属(Claude 子代理文件) */
  threads?: Record<string, string>;
}

const HARNESSES: HarnessId[] = ['claude-code', 'codex', 'opencode', 'doubao'];

async function walk(root: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Claude:transcripts 一文件一会话;projects 下主文件 + <id>/subagents/*.jsonl 归同一会话。 */
function claudeSessionOf(rel: string): { id: string; thread?: string } | null {
  if (!rel.endsWith('.jsonl')) return null;
  if (rel.startsWith('transcripts/')) {
    return { id: rel.slice('transcripts/'.length).replace(/\.jsonl$/, '') };
  }
  if (!rel.startsWith('projects/')) return null;
  const parts = rel.split('/');
  const sub = parts.indexOf('subagents');
  if (sub > 0) {
    return {
      id: parts[sub - 1]!,
      thread: parts[parts.length - 1]!.replace(/\.jsonl$/, ''),
    };
  }
  return { id: parts[parts.length - 1]!.replace(/\.jsonl$/, '') };
}

function isSubagentPath(rel: string): boolean {
  return rel.includes('/subagents/');
}

async function codexSessionOf(abs: string): Promise<string | null> {
  try {
    const text = await readFile(abs, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o['type'] === 'session_meta') {
          const payload = (o['payload'] ?? {}) as Record<string, unknown>;
          if (typeof payload['id'] === 'string') return payload['id'];
        }
      } catch {
        // 跳过损坏行
      }
      // session_meta 总在文件开头;读到第一条非空非 meta 就停
      break;
    }
  } catch {
    // 读不到就用文件名兜底
  }
  return null;
}

function doubaoSessionOf(rel: string): string | null {
  const m =
    /(?:^|\/)\.sessions\/([^/]+)\//.exec(rel) ?? /^conversation\/([^/]+)\//.exec(rel);
  return m?.[1] ?? null;
}

/**
 * 扫描本设备 raw 归档,按 `(harness, sessionId)` 归组。
 * 归组规则与各工具的落盘结构绑定;返回的 files 主文件在前、子代理文件在后。
 */
export async function groupRawSessions(
  vaultRoot: string,
  deviceId: string,
): Promise<RawSession[]> {
  const out: RawSession[] = [];

  for (const harness of HARNESSES) {
    const root = join(rawDeviceDir(vaultRoot, deviceId), harness);
    const files = await walk(root);
    if (!files.length) continue;

    const groups = new Map<string, { files: string[]; threads: Record<string, string> }>();
    const add = (id: string, rel: string, thread?: string) => {
      const g = groups.get(id) ?? { files: [], threads: {} };
      g.files.push(rel);
      if (thread) g.threads[rel] = thread;
      groups.set(id, g);
    };

    for (const rel of files) {
      if (harness === 'claude-code') {
        const hit = claudeSessionOf(rel);
        if (hit) add(hit.id, rel, hit.thread);
      } else if (harness === 'codex') {
        if (!/^(sessions|archived_sessions)\/.*\.jsonl$/.test(rel)) continue;
        const id = await codexSessionOf(join(root, rel));
        add(id ?? rel.split('/').pop()!.replace(/\.jsonl$/, ''), rel);
      } else if (harness === 'opencode') {
        const m = /^sessions\/([^/]+)\.jsonl$/.exec(rel);
        if (m) add(m[1]!, rel);
      } else if (harness === 'doubao') {
        const id = doubaoSessionOf(rel);
        if (id) add(id, rel);
      }
    }

    for (const [id, g] of groups) {
      g.files.sort((a, b) => {
        const sa = isSubagentPath(a) ? 1 : 0;
        const sb = isSubagentPath(b) ? 1 : 0;
        return sa - sb || a.localeCompare(b);
      });
      out.push({ harness, sessionId: id, files: g.files, threads: g.threads });
    }
  }

  out.sort((a, b) => a.harness.localeCompare(b.harness) || a.sessionId.localeCompare(b.sessionId));
  return out;
}

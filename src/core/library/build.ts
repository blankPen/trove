import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HarnessId } from '../../adapters/index.js';
import { mapSession } from '../events/index.js';
import { EVENTS_FORMAT_VERSION, type Event } from '../events/schema.js';
import { libraryDir, librarySessionRelPath, rawFilePath } from '../layout.js';
import type { State } from '../state.js';
import { groupRawSessions } from './group.js';
import { rebuildUnifiedIndex } from './index-file.js';
import { buildSkills } from './skills.js';
import type { IndexShard } from './schema.js';
import { sessionKeyOf } from './schema.js';

export const MAPPER_VERSION = `events@${EVENTS_FORMAT_VERSION}`;

export interface BuildOptions {
  vaultRoot: string;
  deviceId: string;
  state: State;
  now?: () => number;
}

export interface BuildResult {
  sessions: number;
  events: number;
  skills: number;
  written: number;
}

export function shardRelPath(deviceId: string): string {
  return `index/${deviceId}.json`;
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

async function fileHash(path: string): Promise<string | null> {
  try {
    return hashOf(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 会话的源签名:任一 raw 文件游标变化就重建。 */
function signatureOf(state: State, harness: HarnessId, files: string[]): string {
  return files
    .map((rel) => {
      const e = state.sources[harness]?.[rel];
      return e ? `${e.size}:${e.mtimeMs}:${e.prefixHash}` : '?';
    })
    .join('|');
}

function headerFields(events: Event[]): {
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
} {
  const h = events[0];
  return {
    title: h?.title,
    firstText: h?.firstText,
    cwd: h?.cwd,
    model: h?.model?.id,
    startedAt: h?.startedAt,
  };
}

/**
 * 把本设备 raw 归档构建成 library:
 *   library/sessions/<harness>/<session>/<device>.jsonl  (每设备一份)
 *   library/index/<device>.json                          (本设备索引分片)
 * 然后重建统一索引。
 */
export async function buildLibrary(opts: BuildOptions): Promise<BuildResult> {
  const { vaultRoot, deviceId, state } = opts;
  const now = opts.now ?? Date.now;
  const groups = await groupRawSessions(vaultRoot, deviceId);
  const shard: IndexShard = {
    v: 1,
    device: deviceId,
    mapper: MAPPER_VERSION,
    updatedAt: new Date(now()).toISOString(),
    sessions: {},
    skills: {},
  };
  let eventsTotal = 0;
  let written = 0;

  for (const g of groups) {
    const prelimKey = sessionKeyOf(g.harness, g.sessionId);
    const sig = signatureOf(state, g.harness, g.files);
    const rawSources = g.files.map((f) => `raw/${deviceId}/${g.harness}/${f}`);
    const cached = state.library.built[prelimKey];

    if (cached && cached.sig === sig) {
      const sessionId = cached.session ?? g.sessionId;
      const key = sessionKeyOf(g.harness, sessionId);
      const rel = cached.path;
      const abs = join(libraryDir(vaultRoot), ...rel.split('/'));
      const st = await stat(abs).catch(() => null);
      // 原子写保证 size+mtime 相同即内容相同,不必每轮重新哈希
      const unchanged =
        st !== null && cached.size === st.size && cached.mtimeMs === Math.round(st.mtimeMs);
      if (unchanged) {
        shard.sessions[key] = {
          device: deviceId,
          path: rel,
          hash: cached.hash,
          events: cached.events,
          rawSources,
          ...(cached.title ? { title: cached.title } : {}),
          ...(cached.firstText ? { firstText: cached.firstText } : {}),
          ...(cached.cwd ? { cwd: cached.cwd } : {}),
          ...(cached.model ? { model: cached.model } : {}),
          ...(cached.startedAt ? { startedAt: cached.startedAt } : {}),
        };
        eventsTotal += cached.events;
        continue;
      }
    }

    const files = [];
    for (const relFile of g.files) {
      const path = rawFilePath(vaultRoot, deviceId, g.harness, relFile);
      try {
        files.push({
          relPath: relFile,
          rawPath: `raw/${deviceId}/${g.harness}/${relFile}`,
          text: await readFile(path, 'utf8'),
          thread: g.threads?.[relFile],
        });
      } catch {
        // raw 文件缺失:跳过,事件只覆盖存在的部分
      }
    }

    const events = files.length ? mapSession(g.harness, files) : [];
    if (!events.length) continue;
    events[0]!.sources = rawSources;

    const sessionId = events[0]!.session || g.sessionId;
    const key = sessionKeyOf(g.harness, sessionId);
    const rel = librarySessionRelPath(g.harness, sessionId, deviceId);
    const abs = join(libraryDir(vaultRoot), ...rel.split('/'));

    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const hash = hashOf(body);
    if ((await fileHash(abs)) !== hash) {
      await writeAtomic(abs, body);
      written++;
    }
    const st = await stat(abs).catch(() => null);

    const meta = headerFields(events);
    state.library.built[prelimKey] = {
      sig,
      hash,
      events: events.length,
      path: rel,
      session: sessionId,
      ...(st ? { size: st.size, mtimeMs: Math.round(st.mtimeMs) } : {}),
      ...meta,
    };
    shard.sessions[key] = {
      device: deviceId,
      path: rel,
      hash,
      events: events.length,
      rawSources,
      ...meta,
    };
    eventsTotal += events.length;
  }

  const skills = await buildSkills({ vaultRoot, deviceId, state, now });
  shard.skills = skills.entries;

  const shardPath = join(libraryDir(vaultRoot), ...shardRelPath(deviceId).split('/'));
  await writeAtomic(shardPath, JSON.stringify(shard, null, 2) + '\n');
  await rebuildUnifiedIndex(vaultRoot);

  return {
    sessions: Object.keys(shard.sessions).length,
    events: eventsTotal,
    skills: Object.keys(skills.entries).length,
    written: written + skills.written,
  };
}

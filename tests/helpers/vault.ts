import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildUnifiedIndex } from '../../src/core/library/index-file.js';
import { renderFrontmatter, type FrontmatterInput } from '../../src/core/lessons/frontmatter.js';
import type { InboxItem } from '../../src/core/lessons/inbox.js';

/**
 * 测试用 vault 的 base 目录:落在临时目录。
 * vault 本体在 <base>/vault,与 trove 真实布局一致(trovePaths(base).vault)。
 */
export async function tmpVault(prefix = 'trove-web-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** base 下的 vault 根。 */
export function vaultRoot(base: string): string {
  return join(base, 'vault');
}

export interface SeedSession {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  /** 额外事件(除 session 头之外),按 seq 顺序追加。 */
  events?: Array<Record<string, unknown>>;
}

/**
 * 直接落 library 分片与会话文件,模拟 build 的产物。
 * 与 tests/core/sessions.test.ts 的 seed 同一口径。
 */
export async function seedSession(base: string, device: string, h: SeedSession): Promise<void> {
  const vault = vaultRoot(base);
  const rel = `sessions/${h.harness}/${h.session}/${device}.jsonl`;
  const abs = join(vault, 'library', ...rel.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  const lines = [
    JSON.stringify({
      v: 1,
      seq: 0,
      kind: 'session',
      harness: h.harness,
      session: h.session,
      ...(h.title ? { title: h.title } : {}),
      ...(h.firstText ? { firstText: h.firstText } : {}),
      ...(h.cwd ? { cwd: h.cwd } : {}),
      ...(h.model ? { model: { id: h.model } } : {}),
      ...(h.startedAt ? { startedAt: h.startedAt } : {}),
    }),
    ...(h.events ?? []).map((e, i) =>
      JSON.stringify({ v: 1, seq: i + 1, harness: h.harness, session: h.session, ...e }),
    ),
  ];
  await writeFile(abs, lines.join('\n') + '\n');

  const shardPath = join(vault, 'library/index', `${device}.json`);
  let shard: {
    v: 1;
    device: string;
    mapper: string;
    updatedAt: string;
    sessions: Record<string, unknown>;
    skills: Record<string, unknown>;
  };
  try {
    shard = JSON.parse(await readFile(shardPath, 'utf8'));
  } catch {
    shard = { v: 1, device, mapper: 'test', updatedAt: '', sessions: {}, skills: {} };
  }
  shard.sessions[`${h.harness}:${h.session}`] = {
    device,
    path: rel,
    hash: `hash-${h.session}`,
    events: lines.length,
    rawSources: [],
    ...(h.title ? { title: h.title } : {}),
    ...(h.firstText ? { firstText: h.firstText } : {}),
    ...(h.cwd ? { cwd: h.cwd } : {}),
    ...(h.model ? { model: h.model } : {}),
    ...(h.startedAt ? { startedAt: h.startedAt } : {}),
  };
  await mkdir(join(vault, 'library/index'), { recursive: true });
  await writeFile(shardPath, JSON.stringify(shard));
  await rebuildUnifiedIndex(vault);
}

/**
 * 落一条记忆(lessons),带 frontmatter 与正文。
 * frontmatter 用生产代码渲染,免得 fixture 的格式与真实文件漂移。
 */
export async function seedLesson(
  base: string,
  rel: string,
  frontmatter: FrontmatterInput,
  body: string,
): Promise<void> {
  const abs = join(vaultRoot(base), 'library/lessons', ...rel.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, `${renderFrontmatter(frontmatter)}\n${body}\n`);
}

/** 落一条待审候选(inbox 在 lessons 根的 .trove/inbox/ 下);返回绝对路径,便于清理。 */
export async function seedInboxItem(base: string, item: InboxItem): Promise<string> {
  const abs = join(vaultRoot(base), 'library/lessons/.trove/inbox', `${item.id}.json`);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, JSON.stringify(item, null, 2));
  return abs;
}

/** 落一个技能版本:meta 声明文件清单,版本目录存文件内容。 */
export async function seedSkill(
  base: string,
  name: string,
  hash: string,
  files: Record<string, string>,
  opts: { source?: string; device?: string } = {},
): Promise<void> {
  const vault = vaultRoot(base);
  const dir = join(vault, 'library/skills', name, 'versions', hash);
  await mkdir(dir, { recursive: true });
  const list: Array<{ rel: string; size: number }> = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
    list.push({ rel, size: Buffer.byteLength(content) });
  }
  const device = opts.device ?? 'dev1';
  await mkdir(join(vault, 'library/skills', name, 'meta'), { recursive: true });
  await writeFile(
    join(vault, 'library/skills', name, 'meta', `${device}.json`),
    JSON.stringify({
      name,
      device,
      versions: [
        {
          name,
          hash,
          source: opts.source ?? 'self',
          updatedAt: '2026-10-30T09:00:00.000Z',
          files: list,
        },
      ],
    }),
  );
  await rebuildUnifiedIndex(vault);
}

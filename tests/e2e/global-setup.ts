import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedLesson, seedSession, seedSkill } from '../helpers/vault.js';

/** e2e 的 vault 路径,与 playwright.config.ts 里的 HOME 一致。 */
export const E2E_HOME = join(tmpdir(), 'trove-web-e2e');

/**
 * 种子数据:内容全部是 trove 自己的词汇,不是 lorem。
 * 会话 id 固定,断言可以指名道姓。
 */
export default async function globalSetup(): Promise<void> {
  await rm(E2E_HOME, { recursive: true, force: true });

  await seedSession(E2E_HOME, 'dev-laptop', {
    harness: 'claude-code',
    session: 'ses-alpha',
    title: '给 trove 加 web 界面',
    firstText: '给 trove 加 web 界面',
    cwd: '/Users/pz/orca/workspaces/trove',
    model: 'claude-opus-5',
    startedAt: '2026-11-01T09:12:00.000Z',
    events: [
      { kind: 'message', role: 'user', text: '先定 API 契约,再写实现。' },
      { kind: 'message', role: 'assistant', text: '好,先写测试。' },
      { kind: 'tool_call', role: 'assistant', tool: { name: 'Bash', input: { command: 'ls src' } } },
      { kind: 'tool_result', role: 'tool', result: { status: 'ok', output: 'cli.ts\ncore\nserver' } },
      { kind: 'reasoning', role: 'assistant', text: '先把缝定下来。' },
    ],
  });

  await seedSession(E2E_HOME, 'dev-laptop', {
    harness: 'codex',
    session: 'ses-beta',
    firstText: '梳理 vault 的分层',
    cwd: '/Users/pz/orca/workspaces/trove',
    model: 'gpt-5-codex',
    startedAt: '2026-11-02T14:30:00.000Z',
    events: [
      { kind: 'message', role: 'user', text: 'raw 与 library 的边界在哪?' },
      { kind: 'message', role: 'assistant', text: 'raw 是字节,library 是投影。' },
    ],
  });

  await seedSession(E2E_HOME, 'dev-desktop', {
    harness: 'claude-code',
    session: 'ses-gamma',
    title: '教训:路径穿越',
    firstText: '教训:路径穿越',
    cwd: '/Users/pz/orca/workspaces/trove',
    model: 'claude-opus-5',
    startedAt: '2026-11-03T11:05:00.000Z',
    events: [{ kind: 'message', role: 'user', text: 'lessons 的文件读取必须校验路径。' }],
  });

  await seedLesson(
    E2E_HOME,
    'preferences/profile.md',
    {
      type: 'preferences/profile',
      title: '用户画像',
      tags: ['preferences', 'profile'],
      scope: 'global',
      source: 'memo-claude-code',
      createdAt: '2026-10-30T09:33:54.615Z',
    },
    '我是 pz,做工具链与基础设施。\n\n**Why:** 用户自己说明。\n\n**How to apply:** 回复用简体中文,先给结论。',
  );

  await seedLesson(
    E2E_HOME,
    'experiences/gotcha-path.md',
    {
      type: 'experiences/gotcha',
      title: 'safeSessionName 会改目录名',
      tags: ['experiences', 'gotcha'],
      scope: 'global',
      source: null,
      createdAt: '2026-10-31T02:10:00.000Z',
    },
    '会话 id 里的非法字符会被替换成下划线,索引的键是真名,目录名是 safe 名。\n\n取文件必须过 `safeSessionName()`。',
  );

  await seedSkill(
    E2E_HOME,
    'cookie-cloud',
    'hashcookie01',
    {
      'SKILL.md': '---\nname: cookie-cloud\n---\n\n取登录 cookie 的技能。\n',
      'get_cookie.py': 'print("cookie")\n',
    },
    { source: 'github', device: 'dev-laptop' },
  );
}

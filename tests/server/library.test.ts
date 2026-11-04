import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { trovePaths } from '../../src/paths.js';
import { defaultConfig } from '../../src/config.js';
import { seedLesson, seedSession, seedSkill, tmpVault } from '../helpers/vault.js';

/** 沉淀与技能的 HTTP 缝。 */
describe('trove web API · 沉淀与技能', () => {
  let server: RunningServer;
  let base: string;

  beforeAll(async () => {
    base = await tmpVault();
    await seedLesson(
      base,
      'preferences/profile.md',
      {
        type: 'preferences/profile',
        title: '用户画像',
        tags: ['preferences', 'profile'],
        scope: 'global',
        source: 'memo-claude-code',
        createdAt: '2026-10-30T09:33:54.615Z',
      },
      '我是 pz，做基础设施与工具链。\n\n**Why:** 用户明确要求。',
    );
    await seedLesson(
      base,
      'experiences/gotcha-path.md',
      {
        type: 'experiences/gotcha',
        title: 'safeSessionName 会改目录名',
        tags: ['experiences', 'gotcha'],
        scope: 'global',
        source: null,
      },
      '含 `/` 的会话 id 会被替换成下划线。',
    );
    await seedSkill(base, 'cookie-cloud', 'hash-aaa', {
      'SKILL.md': '---\nname: cookie-cloud\n---\n\n取 cookie 的技能。',
      'get_cookie.py': 'print("cookie")\n',
    });
    await seedSession(base, 'dev1', {
      harness: 'claude-code',
      session: 's-a',
      startedAt: '2026-10-22T13:00:00.000Z',
    });

    server = await startServer({
      paths: trovePaths(base),
      config: defaultConfig({ deviceId: 'dev1', deviceName: 'pzdeMac-mini' }),
      remote: null,
      adapters: [],
      port: 0,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('沉淀按五类分组,每条带 frontmatter 与正文预览', async () => {
    const res = await fetch(`${server.url}/api/lessons`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const cats = body.map((c: { category: string }) => c.category);
    expect(cats).toEqual(['preferences', 'experiences']);
    const profile = body[0].items[0];
    expect(profile).toMatchObject({
      path: 'preferences/profile.md',
      title: '用户画像',
      type: 'preferences/profile',
      scope: 'global',
    });
    expect(profile.preview).toContain('我是 pz');
  });

  it('沉淀文件按相对路径读取', async () => {
    const res = await fetch(
      `${server.url}/api/lessons/file?path=${encodeURIComponent('preferences/profile.md')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain('我是 pz');
  });

  it('沉淀文件拒绝路径穿越', async () => {
    for (const bad of ['../../config.json', '/etc/passwd', 'preferences/../../config.json']) {
      const res = await fetch(`${server.url}/api/lessons/file?path=${encodeURIComponent(bad)}`);
      expect(res.status, `应当拒绝 ${bad}`).toBe(404);
    }
  });

  it('技能列表给出版本谱系与文件清单', async () => {
    const res = await fetch(`${server.url}/api/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'cookie-cloud', latest: 'hash-aaa' });
    expect(body[0].versions[0].files.map((f: { rel: string }) => f.rel)).toEqual([
      'SKILL.md',
      'get_cookie.py',
    ]);
  });

  it('技能文件按版本与相对路径读取', async () => {
    const res = await fetch(
      `${server.url}/api/skills/file?name=cookie-cloud&hash=hash-aaa&rel=${encodeURIComponent('get_cookie.py')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain('print("cookie")');
  });

  it('技能文件拒绝未在清单内的路径与不存在的版本', async () => {
    const bad = await fetch(
      `${server.url}/api/skills/file?name=cookie-cloud&hash=hash-aaa&rel=${encodeURIComponent('../../../config.json')}`,
    );
    expect(bad.status).toBe(404);
    const noHash = await fetch(
      `${server.url}/api/skills/file?name=cookie-cloud&hash=nope&rel=SKILL.md`,
    );
    expect(noHash.status).toBe(404);
  });

  it('用量接口返回 trove 自身的台账结构', async () => {
    const res = await fetch(`${server.url}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(body.byTask).toEqual({});
    expect(body.byModel).toEqual({});
    // 没配 LLM 时台账必然是空的 —— 空态要说清原因
    expect(body.llmConfigured).toBe(false);
  });
});

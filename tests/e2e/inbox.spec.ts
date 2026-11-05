import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { seedInboxItem } from '../helpers/vault.js';
import { E2E_HOME } from './global-setup.js';
import type { InboxItem } from '../../src/core/lessons/inbox.js';

const ITEM: InboxItem = {
  id: 'inbox_e2e',
  session: 'ses-alpha',
  type: 'experiences/gotcha',
  title: 'git push 权限排查',
  content: '## 做法\n先加 SSH key,再推。',
  evidence: [{ session: 'ses-alpha', seq: 1, quote: 'Permission denied (publickey)' }],
  quality: { specific: 0.9, actionable: 0.8, transferable: 0.7, evidence: 1, non_duplicate: 0.9 },
  promptVersion: 'exp-v3',
  createdAt: '2026-11-04T09:00:00.000Z',
};

test('Inbox:页面渲染与空状态', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  // 种子 vault 没有 inbox 候选 → 空态
  await expect(page.getByText('暂无待审候选')).toBeVisible();
});

test('Inbox:待审卡片与接受后的写入路径', async ({ page }) => {
  const path = await seedInboxItem(E2E_HOME, ITEM);
  try {
    // 接受要真后端 + LLM 配置(e2e vault 故意不配),这里只钉 UI 契约:拦截 accept 返回写入路径。
    await page.route('**/api/inbox/*/accept', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ paths: ['experiences/2026-11-04-git-push.md'] }),
      }),
    );
    await page.goto('/#/inbox');

    // 顶部:trust 等级 + 待审数量
    await expect(page.getByText('trust L0')).toBeVisible();
    await expect(page.getByText('待审 1')).toBeVisible();

    // 卡片:标题、类型、质量五维、来源会话、证据(折叠)、正文预览
    await expect(page.getByRole('heading', { name: 'git push 权限排查' })).toBeVisible();
    await expect(page.getByText('experiences/gotcha')).toBeVisible();
    await expect(page.getByText('具体 90')).toBeVisible();
    await expect(page.getByText('ses-alpha')).toBeVisible();
    await expect(page.getByText('证据 1 条')).toBeVisible();
    await expect(page.getByText('先加 SSH key', { exact: false })).toBeVisible();

    // 接受后显示写入路径
    await page.getByRole('button', { name: '接受', exact: true }).click();
    await expect(page.getByText('已写入 1 个文件')).toBeVisible();
    await expect(page.getByText('experiences/2026-11-04-git-push.md')).toBeVisible();
  } finally {
    await rm(path, { force: true });
  }
});

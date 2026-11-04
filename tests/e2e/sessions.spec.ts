import { test, expect } from '@playwright/test';

test('会话列表:三条会话按开始时间倒序', async ({ page }) => {
  await page.goto('/#/sessions');
  await expect(page.getByRole('heading', { name: '会话' })).toBeVisible();
  await expect(page.getByText('3 次会话')).toBeVisible();

  await expect(page.getByRole('link', { name: '给 trove 加 web 界面' })).toBeVisible();
  await expect(page.getByRole('link', { name: '梳理 vault 的分层' })).toBeVisible();
  await expect(page.getByRole('link', { name: '教训:路径穿越' })).toBeVisible();
});

test('按工具过滤会话', async ({ page }) => {
  await page.goto('/#/sessions');

  await page.getByRole('button', { name: 'Codex' }).click();
  await expect(page.getByText('1 次会话')).toBeVisible();
  await expect(page.getByRole('link', { name: '梳理 vault 的分层' })).toBeVisible();
  await expect(page.getByRole('link', { name: '给 trove 加 web 界面' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Claude Code' }).click();
  await expect(page.getByText('2 次会话')).toBeVisible();
  await expect(page.getByRole('link', { name: '给 trove 加 web 界面' })).toBeVisible();
  await expect(page.getByRole('link', { name: '教训:路径穿越' })).toBeVisible();
});

test('正文关键词搜索会话', async ({ page }) => {
  await page.goto('/#/sessions');

  await page.getByRole('textbox', { name: '搜索会话' }).fill('路径穿越');
  await page.getByRole('button', { name: '搜索' }).click();

  await expect(page.getByText('正文命中')).toBeVisible();
  await expect(page.getByRole('link', { name: '教训:路径穿越' })).toBeVisible();
  await expect(page.getByRole('link', { name: '给 trove 加 web 界面' })).toHaveCount(0);

  // 清除恢复全部
  await page.getByRole('button', { name: '清除' }).click();
  await expect(page.getByText('3 次会话')).toBeVisible();
});

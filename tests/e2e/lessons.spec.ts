import { test, expect } from '@playwright/test';

test('沉淀:分组列表与默认正文', async ({ page }) => {
  await page.goto('/#/lessons');
  await expect(page.getByRole('heading', { name: '沉淀' })).toBeVisible();
  await expect(page.getByText('2 条记忆')).toBeVisible();

  await expect(page.getByRole('button', { name: /用户画像/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /safeSessionName 会改目录名/ })).toBeVisible();

  // 默认选中第一条,正文 markdown 渲染出来
  await expect(page.getByText('我是 pz', { exact: false })).toBeVisible();
});

test('沉淀:切换选中条目与全文搜索', async ({ page }) => {
  await page.goto('/#/lessons');

  // 点第二条,正文跟着换
  await page.getByRole('button', { name: /safeSessionName 会改目录名/ }).click();
  await expect(page.getByRole('heading', { name: 'safeSessionName 会改目录名' })).toBeVisible();

  // 正文关键词过滤
  await page.getByRole('textbox', { name: '搜索记忆' }).fill('工具链');
  await expect(page.getByRole('button', { name: /用户画像/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /safeSessionName 会改目录名/ })).toHaveCount(0);
});

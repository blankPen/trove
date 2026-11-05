import { test, expect } from '@playwright/test';

test('健康:记忆库体检概览', async ({ page }) => {
  await page.goto('/#/health');
  await expect(page.getByRole('heading', { name: '健康' })).toBeVisible();

  // 种子 vault:偏好 1 条 + 经验 1 条(经验没有 evidence → 缺证据 1)
  await expect(page.locator('.kpi', { hasText: '记忆' }).locator('.kpi-value')).toHaveText('2');
  await expect(page.locator('.kpi', { hasText: '缺证据' }).locator('.kpi-value')).toHaveText('1');
  await expect(page.locator('.kpi', { hasText: '重复' }).locator('.kpi-value')).toHaveText('0');
  await expect(page.locator('.kpi', { hasText: '未引用轨迹' }).locator('.kpi-value')).toHaveText('0');

  await expect(page.getByRole('heading', { name: '分类分布' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '使用信号' })).toBeVisible();
  // 种子 vault 没有作业队列与向量索引
  await expect(page.getByText('还没有学习作业队列')).toBeVisible();
  await expect(page.getByText('还没有向量索引')).toBeVisible();
});

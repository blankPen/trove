import { test, expect } from '@playwright/test';

test('用量:空台账时的上手三步', async ({ page }) => {
  await page.goto('/#/usage');
  await expect(page.getByRole('heading', { name: '用量' })).toBeVisible();

  // 台账为空:四个计数都是 0
  await expect(page.locator('.kpi', { hasText: '调用次数' }).locator('.kpi-value')).toHaveText('0');
  await expect(page.locator('.kpi', { hasText: '合计' }).locator('.kpi-value')).toHaveText('0');

  // 三步引导
  await expect(page.getByRole('heading', { name: '让台账有数的三步' })).toBeVisible();
  await expect(page.getByText('配上 LLM 端点')).toBeVisible();
  await expect(page.getByText('跑一次经验提取')).toBeVisible();
  await expect(page.getByText('台账出现记录')).toBeVisible();

  // 端点三个字段都未配(测试 vault 没有 config.json)
  await expect(page.getByText('baseUrl 未配')).toBeVisible();
  await expect(page.getByText('model 未配')).toBeVisible();
  await expect(page.getByText('apiKey 未配')).toBeVisible();
});

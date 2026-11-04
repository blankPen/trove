import { test, expect } from '@playwright/test';

test('会话详情:事件流、装订线与事实', async ({ page }) => {
  await page.goto('/#/sessions');
  await page.getByRole('link', { name: '给 trove 加 web 界面' }).click();

  // 返回链接与标题
  await expect(page.getByRole('link', { name: '← 全部会话' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '给 trove 加 web 界面' })).toBeVisible();

  // 事实条:工具与模型
  await expect(page.getByText('Claude Code')).toBeVisible();
  await expect(page.getByText('claude-opus-5').first()).toBeVisible();

  // 事件流:6 条(1 头 + 5 事件),seq 装订线从 0 起
  await expect(page.locator('.event')).toHaveCount(6);
  await expect(page.locator('.seq').first()).toHaveText('0');

  // 正文与工具调用渲染
  await expect(page.getByText('先定 API 契约,再写实现。')).toBeVisible();
  await expect(page.getByText('Bash')).toBeVisible();
  await expect(page.getByText('共 6 条事件')).toBeVisible();
});

test('会话详情:只有头的事件流', async ({ page }) => {
  await page.goto('/#/sessions');
  await page.getByRole('link', { name: '教训:路径穿越' }).click();

  await expect(page.getByRole('heading', { name: '教训:路径穿越' })).toBeVisible();
  await expect(page.locator('.event')).toHaveCount(2);
  await expect(page.getByText('共 2 条事件')).toBeVisible();
});

test('会话详情:事件加载完不再重复请求(防无限滚动循环)', async ({ page }) => {
  let eventsRequests = 0;
  page.on('request', (r) => {
    if (r.url().includes('/events?offset=')) eventsRequests += 1;
  });

  await page.goto('/#/sessions');
  await page.getByRole('link', { name: '给 trove 加 web 界面' }).click();

  // 6 条事件一页拉完,应稳定在"共 6 条事件",且只发一次事件请求
  await expect(page.getByText('共 6 条事件')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(eventsRequests).toBe(1);
});

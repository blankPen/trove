import { test, expect } from '@playwright/test';

test('技能:版本、文件列表与内容', async ({ page }) => {
  await page.goto('/#/skills');
  await expect(page.getByRole('heading', { name: '技能' })).toBeVisible();
  await expect(page.getByText('1 个技能')).toBeVisible();

  // 详情头
  await expect(page.getByRole('heading', { name: 'cookie-cloud' })).toBeVisible();

  // 文件列表
  await expect(page.getByRole('button', { name: 'SKILL.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'get_cookie.py' })).toBeVisible();

  // 默认打开第一个文件(SKILL.md 渲染成 markdown,frontmatter 被剥掉)
  await expect(page.locator('.prose')).toContainText('取登录 cookie 的技能');

  // 点第二个文件(.py 按语法着色),内容跟着换
  await page.getByRole('button', { name: 'get_cookie.py' }).click();
  await expect(page.locator('pre.code')).toContainText('print');
});

test('技能:按名或来源搜索', async ({ page }) => {
  await page.goto('/#/skills');

  await page.getByRole('textbox', { name: '搜索技能' }).fill('github');
  await expect(page.getByRole('heading', { name: 'cookie-cloud' })).toBeVisible();

  await page.getByRole('textbox', { name: '搜索技能' }).fill('不存在的技能');
  await expect(page.getByText('没有匹配的技能')).toBeVisible();
});

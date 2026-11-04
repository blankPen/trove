import { test, expect, type Page } from '@playwright/test';

/** KPI 单元的数值:label 是它左侧的中文名。 */
function kpiValue(page: Page, label: string) {
  return page.locator('.kpi', { hasText: label }).locator('.kpi-value');
}

test('总览:计数、最近会话与动作按钮', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '归档', exact: true })).toBeVisible();

  await expect(kpiValue(page, '会话')).toHaveText('3');
  await expect(kpiValue(page, '事件')).toHaveText('11');
  await expect(kpiValue(page, '记忆')).toHaveText('2');
  await expect(kpiValue(page, '技能')).toHaveText('1');

  // 最近会话(按开始时间倒序的头四条)
  await expect(page.getByRole('link', { name: '给 trove 加 web 界面' })).toBeVisible();
  await expect(page.getByRole('link', { name: '梳理 vault 的分层' })).toBeVisible();
  await expect(page.getByRole('link', { name: '教训:路径穿越' })).toBeVisible();

  // 动作按钮可点(不真的点:同步会扫本机,daemon 会拉起进程)
  await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '重启 daemon' })).toBeEnabled();
});

test('侧栏导航到五个页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '归档', exact: true })).toBeVisible();

  await page.getByRole('link', { name: '会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话' })).toBeVisible();

  await page.getByRole('link', { name: '沉淀', exact: true }).click();
  await expect(page.getByRole('heading', { name: '沉淀' })).toBeVisible();

  await page.getByRole('link', { name: '技能', exact: true }).click();
  await expect(page.getByRole('heading', { name: '技能' })).toBeVisible();

  await page.getByRole('link', { name: '用量', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用量' })).toBeVisible();
});

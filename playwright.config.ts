import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * e2e 跑在真实的 trove web 上:真后端、真构建产物、真浏览器。
 * vault 用固定路径的临时种子数据(global-setup 写入),不碰真机 vault ——
 * 真机 vault 有 694MB,深搜要扫全库,测试既慢又不确定。
 */
const HOME = join(tmpdir(), 'trove-web-e2e');

export default defineConfig({
  testDir: './tests/e2e',
  // 只认浏览器 e2e 的 .spec.ts;tests/e2e/ 里还有 vitest 的 *.integration.test.ts
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:8788',
    trace: 'retain-on-failure',
  },
  // channel:'chromium' 用完整 chromium 的新 headless 模式,免装独立的 headless-shell 下载
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  webServer: {
    command: 'node dist/main.js web --port 8788',
    url: 'http://127.0.0.1:8788/api/overview',
    env: { TROVE_HOME: HOME },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

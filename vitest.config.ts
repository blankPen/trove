import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 集成测试(真实 WebDAV)可能较慢,给足超时
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

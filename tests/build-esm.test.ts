import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 构建产物冒烟:dist 是 ESM(package.json type=module),
 * 源码里若混进 require() 会在运行时炸 —— vitest 转译掩盖了这个问题,
 * 只有跑真实构建产物才能发现。
 *
 * 注意:不能直接 import dist/main.js —— 它是 CLI 入口,import 就会执行并打印帮助。
 * 这里 import 的是 store 模块(真正含 require 风险的地方)。
 */

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');

describe('构建产物冒烟', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'trove-build-'));
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('dist/remote/s3-store.js 能作为 ESM 加载(没有 require is not defined)', async () => {
    const mod = join(repoRoot, 'dist', 'remote', 's3-store.js');
    await expect(
      exec('node', ['-e', `import('${mod}').then(m => { if (typeof m.S3Store !== 'function') throw new Error('缺少 S3Store 导出'); })`], {
        cwd: base,
      }),
    ).resolves.toBeTruthy();
  });

  it('dist/remote/prompt.js 与 create-remote.js 也能加载', async () => {
    for (const f of ['prompt.js', 'create-remote.js']) {
      const mod = join(repoRoot, 'dist', 'remote', f);
      await expect(exec('node', ['-e', `import('${mod}')`], { cwd: base })).resolves.toBeTruthy();
    }
  });

  it('init 走 S3 分支不因 ESM/require 问题崩溃', async () => {
    // 凭证无效,预期是连到 S3 后报鉴权错,而不是 require is not defined
    let stdout = '';
    let stderr = '';
    try {
      const r = await exec(
        'node',
        [
          join(repoRoot, 'dist', 'main.js'),
          'init',
          '--type',
          's3',
          '--provider',
          'aliyun',
          '--region',
          'cn-hangzhou',
          '--bucket',
          'test-bucket',
          '--access-key-id',
          'AK',
          '--secret-access-key',
          'SK',
          '--no-daemon',
        ],
        { cwd: base, env: { ...process.env, TROVE_HOME: join(base, 'home') } },
      );
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    const combined = stdout + stderr;
    expect(combined).not.toContain('require is not defined');
    expect(combined).not.toContain('ERR_MODULE_NOT_FOUND');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Remote, RemoteFile } from '../src/remote/types.js';
import { pullRemote, pushLocal, sync } from '../src/sync.js';
import type { Manifest } from '../src/core/types.js';

/** 内存版远端:用真实文件系统承载本地端,远端用 Map 模拟。 */
class FakeRemote implements Remote {
  files = new Map<string, Buffer>();
  uploaded: string[] = [];
  downloaded: string[] = [];

  async listAll(): Promise<RemoteFile[]> {
    return [...this.files.entries()].map(([path, buf]) => ({ path, size: buf.length }));
  }
  async download(remotePath: string, localPath: string): Promise<void> {
    this.downloaded.push(remotePath);
    const buf = this.files.get(remotePath);
    if (!buf) throw new Error(`远端无此文件: ${remotePath}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }
  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploaded.push(remotePath);
    this.files.set(remotePath, await readFile(localPath));
  }
  async delete(remotePath: string): Promise<void> {
    this.files.delete(remotePath);
  }
}

const DEVICE = 'a3f2c81e';

describe('pushLocal(vault → 远端)', () => {
  let vaultRoot: string;
  let remote: FakeRemote;
  let manifest: Manifest;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'trove-push-'));
    remote = new FakeRemote();
    manifest = {};
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  async function putVault(rel: string, content: string) {
    const p = join(vaultRoot, 'devices', DEVICE, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }

  it('新文件上传到远端 {deviceId}/... 并写入 manifest', async () => {
    await putVault('claude-code/projects/-p/a.jsonl', 'hello\n');

    const r = await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });

    expect(r.uploaded).toBe(1);
    expect(r.skipped).toBe(0);
    // 远端布局是 {device_id}/...,没有 devices/ 前缀(设计 §6.3)
    expect(remote.files.get('a3f2c81e/claude-code/projects/-p/a.jsonl')?.toString()).toBe(
      'hello\n',
    );
    expect(manifest['claude-code/projects/-p/a.jsonl']).toBeDefined();
  });

  it('指纹未变 → skip,不重复上传', async () => {
    await putVault('claude-code/projects/-p/a.jsonl', 'hello\n');
    await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });

    const r = await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });
    expect(r.uploaded).toBe(0);
    expect(r.skipped).toBe(1);
    expect(remote.uploaded).toHaveLength(1);
  });

  it('内容变化 → full 重传', async () => {
    await putVault('claude-code/projects/-p/a.jsonl', 'hello\n');
    await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });

    await putVault('claude-code/projects/-p/a.jsonl', 'hello\nworld\n');
    const r = await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });

    expect(r.uploaded).toBe(1);
    expect(remote.files.get('a3f2c81e/claude-code/projects/-p/a.jsonl')?.toString()).toBe(
      'hello\nworld\n',
    );
  });

  it('远端文件被删 → 即使 manifest 一致也重传(远端即真相)', async () => {
    await putVault('claude-code/projects/-p/a.jsonl', 'hello\n');
    await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });
    expect(remote.files.size).toBe(1);

    // 模拟远端整盘被清空(本地 manifest 仍标着已同步)
    remote.files.clear();

    const r = await pushLocal({ remote, deviceId: DEVICE, vaultRoot, manifest });
    expect(r.uploaded).toBe(1);
    expect(remote.files.get('a3f2c81e/claude-code/projects/-p/a.jsonl')?.toString()).toBe(
      'hello\n',
    );
  });
});

describe('pullRemote(远端 → vault)', () => {
  let vaultRoot: string;
  let remote: FakeRemote;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'trove-pull-'));
    remote = new FakeRemote();
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('下载别人的设备目录,字节一致', async () => {
    remote.files.set('b91d4a07/claude-code/projects/-q/b.jsonl', Buffer.from('world\n'));

    const r = await pullRemote({ remote, deviceId: DEVICE, vaultRoot });

    expect(r.downloaded).toBe(1);
    const local = await readFile(
      join(vaultRoot, 'devices', 'b91d4a07', 'claude-code', 'projects', '-q', 'b.jsonl'),
      'utf8',
    );
    expect(local).toBe('world\n');
  });

  it('跳过自己的设备目录(设计 §10.3 ②)', async () => {
    remote.files.set('a3f2c81e/claude-code/projects/-p/a.jsonl', Buffer.from('mine\n'));
    remote.files.set('b91d4a07/claude-code/projects/-q/b.jsonl', Buffer.from('other\n'));

    const r = await pullRemote({ remote, deviceId: DEVICE, vaultRoot });

    expect(r.downloaded).toBe(1); // 只下载别人的
    expect(remote.downloaded).toEqual(['b91d4a07/claude-code/projects/-q/b.jsonl']);
  });

  it('本地已存在且 size 一致 → 跳过(阶段 1 用 size 判定)', async () => {
    remote.files.set('b91d4a07/claude-code/projects/-q/b.jsonl', Buffer.from('world\n'));
    await pullRemote({ remote, deviceId: DEVICE, vaultRoot });

    const r2 = await pullRemote({ remote, deviceId: DEVICE, vaultRoot });
    expect(r2.downloaded).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it('拒绝含 .. 的路径(远端不可信,防路径穿越)', async () => {
    remote.files.set('evil/../../etc/pwned.jsonl', Buffer.from('x\n'));

    const r = await pullRemote({ remote, deviceId: DEVICE, vaultRoot });

    expect(r.downloaded).toBe(0);
    expect(remote.downloaded).toHaveLength(0);
  });
});

describe('sync(pull → push 端到端)', () => {
  it('两设备互相可见:先 pull 别人的,再 push 自己的', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'trove-sync-'));
    const remote = new FakeRemote();
    try {
      // 远端已有另一台设备的文件
      remote.files.set('b91d4a07/claude-code/projects/-q/b.jsonl', Buffer.from('world\n'));

      // 本地已有自己的文件
      const mine = join(vaultRoot, 'devices', DEVICE, 'claude-code', 'projects', '-p', 'a.jsonl');
      await mkdir(dirname(mine), { recursive: true });
      await writeFile(mine, 'hello\n');

      const manifestPath = join(vaultRoot, '.trove', 'manifest.json');
      const report = await sync({
        remote,
        deviceId: DEVICE,
        deviceName: 'pz-macbook',
        vaultRoot,
        manifestPath,
        now: () => 1_700_000_000_000,
      });

      expect(report.pulled).toBe(1);
      expect(report.pushed).toBe(2); // a.jsonl + meta.json
      // 自己的文件已到远端
      expect(remote.files.get('a3f2c81e/claude-code/projects/-p/a.jsonl')?.toString()).toBe(
        'hello\n',
      );
      // 别人的文件已到本地
      expect(
        await readFile(
          join(vaultRoot, 'devices', 'b91d4a07', 'claude-code', 'projects', '-q', 'b.jsonl'),
          'utf8',
        ),
      ).toBe('world\n');
      // meta.json 写入本地并上传
      const meta = JSON.parse(
        (await readFile(join(vaultRoot, 'devices', DEVICE, 'meta.json'), 'utf8')) as string,
      );
      expect(meta).toEqual({ id: DEVICE, name: 'pz-macbook', lastSeen: 1_700_000_000_000 });
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('dry-run 不拉取、不写 meta、不落盘', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'trove-dryrun-'));
    const remote = new FakeRemote();
    try {
      remote.files.set('b91d4a07/claude-code/projects/-q/b.jsonl', Buffer.from('world\n'));

      const manifestPath = join(vaultRoot, '.trove', 'manifest.json');
      const report = await sync({
        remote,
        deviceId: DEVICE,
        deviceName: 'pz-macbook',
        vaultRoot,
        manifestPath,
        dryRun: true,
        now: () => 1_700_000_000_000,
      });

      expect(report.pulled).toBe(0);
      await expect(
        readFile(join(vaultRoot, 'devices', 'b91d4a07', 'claude-code', 'projects', '-q', 'b.jsonl'), 'utf8'),
      ).rejects.toThrow();
      await expect(
        readFile(join(vaultRoot, 'devices', DEVICE, 'meta.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

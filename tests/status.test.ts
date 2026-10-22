import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStatus } from '../src/status.js';
import type { Manifest } from '../src/core/types.js';

const HARNESSES = [
  { id: 'claude-code', displayName: 'Claude Code', sessionGlob: 'projects/**/*.jsonl' },
];

describe('computeStatus(设计 §10.4)', () => {
  let vaultRoot: string;
  const deviceId = 'a3f2c81e';

  async function write(rel: string, content: string) {
    const p = join(vaultRoot, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
  }

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'trove-status-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('统计各设备会话数与字节数(只数 projects 下的 .jsonl)', async () => {
    await write(`devices/${deviceId}/claude-code/projects/-p/a.jsonl`, 'a'.repeat(100));
    await write(`devices/${deviceId}/claude-code/projects/-p/b.jsonl`, 'b'.repeat(200));
    await write(`devices/${deviceId}/claude-code/history.jsonl`, 'h'.repeat(50)); // 非会话
    await write(`devices/${deviceId}/meta.json`, JSON.stringify({ id: deviceId, name: 'pz-macbook' }));
    await write('devices/b91d4a07/claude-code/projects/-q/c.jsonl', 'c'.repeat(300));
    await write('devices/b91d4a07/meta.json', JSON.stringify({ id: 'b91d4a07', name: 'work-mac' }));

    const s = await computeStatus({
      vaultRoot,
      deviceId,
      deviceName: 'pz-macbook',
      manifest: {},
      harnesses: HARNESSES,
    });

    const mine = s.devices.find((d) => d.id === deviceId)!;
    expect(mine.name).toBe('pz-macbook');
    expect(mine.harnesses).toEqual([
      { id: 'claude-code', displayName: 'Claude Code', sessionCount: 2, bytes: 300 },
    ]);

    const other = s.devices.find((d) => d.id === 'b91d4a07')!;
    expect(other.name).toBe('work-mac');
    expect(other.harnesses).toEqual([
      { id: 'claude-code', displayName: 'Claude Code', sessionCount: 1, bytes: 300 },
    ]);
  });

  it('按 harness 区分会话(claude-code 与 codex 分开计数)', async () => {
    await write(`devices/${deviceId}/claude-code/projects/-p/a.jsonl`, 'a'.repeat(100));
    await write(`devices/${deviceId}/codex/sessions/2026/10/22/s.jsonl`, 'c'.repeat(50));

    const s = await computeStatus({
      vaultRoot,
      deviceId,
      deviceName: 'me',
      manifest: {},
      harnesses: [
        { id: 'claude-code', displayName: 'Claude Code', sessionGlob: 'projects/**/*.jsonl' },
        { id: 'codex', displayName: 'Codex', sessionGlob: 'sessions/**/*.jsonl' },
      ],
    });

    expect(s.devices.find((d) => d.id === deviceId)!.harnesses).toEqual([
      { id: 'claude-code', displayName: 'Claude Code', sessionCount: 1, bytes: 100 },
      { id: 'codex', displayName: 'Codex', sessionCount: 1, bytes: 50 },
    ]);
  });

  it('meta.json 缺失时回退用目录名作为设备名', async () => {
    await write('devices/b91d4a07/claude-code/projects/-q/c.jsonl', 'x');

    const s = await computeStatus({ vaultRoot, deviceId, deviceName: 'me', manifest: {}, harnesses: HARNESSES });
    expect(s.devices.find((d) => d.id === 'b91d4a07')!.name).toBe('b91d4a07');
  });

  it('根据 manifest 计算待同步文件(空 manifest → 全部为 new)', async () => {
    await write(`devices/${deviceId}/claude-code/projects/-p/a.jsonl`, 'aaa');
    await write(`devices/${deviceId}/claude-code/projects/-p/b.jsonl`, 'bbbb');

    const s = await computeStatus({ vaultRoot, deviceId, deviceName: 'me', manifest: {}, harnesses: HARNESSES });
    expect(s.pendingCount).toBe(2);
    expect(s.pendingBytes).toBe(3 + 4);
  });

  it('manifest 已同步的文件不再计入待同步', async () => {
    await write(`devices/${deviceId}/claude-code/projects/-p/a.jsonl`, 'aaa');
    await write(`devices/${deviceId}/claude-code/projects/-p/b.jsonl`, 'bbbb');

    const { computeFingerprint } = await import('../src/core/fingerprint.js');
    const fp = await computeFingerprint(
      join(vaultRoot, 'devices', deviceId, 'claude-code', 'projects', '-p', 'a.jsonl'),
    );
    const manifest: Manifest = {
      'claude-code/projects/-p/a.jsonl': {
        path: 'claude-code/projects/-p/a.jsonl',
        fingerprint: fp,
        syncedSize: fp.size,
        syncedAt: 1,
      },
    };

    const s = await computeStatus({ vaultRoot, deviceId, deviceName: 'me', manifest, harnesses: HARNESSES });
    expect(s.pendingCount).toBe(1);
    expect(s.pending[0]!.path).toBe('claude-code/projects/-p/b.jsonl');
    expect(s.pending[0]!.reason).toBe('new');
  });
});

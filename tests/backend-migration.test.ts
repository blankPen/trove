import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { pushLocal } from '../src/core/push.js';
import { emptyState, type State } from '../src/core/state.js';
import { MemoryRemote } from './helpers/memory-remote.js';

/**
 * 换后端(WebDAV → S3)时的历史数据迁移。
 *
 * 关键:本地 state.pushed 记录的是"推到某个远端"的快照。
 * 换后端后新远端是空的,绝不能因为本地 state 有记录就跳过上传 ——
 * 否则新远端只有索引没有数据,静默丢数据。
 *
 * 解法:state 记住这些记录属于哪个远端(remoteId);
 * 远端身份变了,本地记录就作废,必须整份重推。
 */

const CHUNK = 4 * 1024 * 1024;

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-migrate-'));
  const vault = join(base, 'vault');
  await mkdir(join(vault, 'raw', 'dev1', 'claude-code'), { recursive: true });
  const file = join(vault, 'raw', 'dev1', 'claude-code', 'a.jsonl');
  // 2 个整块 + 1 个半块:整块可复用,半块必须重传
  const size = 2 * CHUNK + 1024;
  await writeFile(file, Buffer.alloc(size, 'x'));
  return { base, vault, file, relPath: 'a.jsonl', size };
}

/** 与真实分块一致:整块 + 尾块 */
function stateWithPushed(gen: string, size: number): State {
  const s = emptyState();
  const sha = 'a'.repeat(64);
  const chunks = [
    { offset: 0, length: CHUNK, sha256: sha },
    { offset: CHUNK, length: CHUNK, sha256: sha },
    { offset: 2 * CHUNK, length: size - 2 * CHUNK, sha256: sha },
  ];
  s.sources['claude-code'] = {
    'a.jsonl': {
      sessionKey: 's1',
      sessionMtimeMs: 1,
      generation: gen,
      size,
      mtimeMs: 1,
      prefixHash: 'p',
    },
  };
  s.pushed['claude-code'] = {
    'a.jsonl': { generation: gen, size, chunks, chunksHash: 'h' },
  };
  return s;
}

describe('换后端后的历史数据迁移', () => {
  it('远端身份变了:本地旧记录作废,新后端收到全部数据', async () => {
    const { vault, size } = await setup();
    const state = stateWithPushed('gen1', size);
    // state 里的记录属于旧的 WebDAV 后端
    state.remoteId = 'webdav:http://old.example/';
    const newRemote = new MemoryRemote();

    const result = await pushLocal({
      remote: newRemote,
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      remoteId: 's3:https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/my-bucket',
    });

    // 关键断言:新远端真的收到了全部块
    expect(result.uploadedItems).toBe(1);
    expect(result.uploadedChunks).toBe(3);
    expect(result.uploadedBytes).toBe(size);
    expect(newRemote.writes.length).toBeGreaterThan(0);
  });

  it('远端身份没变:索引丢失时仍可复用本地 state 的块(只补半块)', async () => {
    const { vault, size } = await setup();
    const state = stateWithPushed('gen1', size);
    state.remoteId = 'webdav:http://old.example/';
    const remote = new MemoryRemote();

    // 远端索引为空(模拟索引丢失),但远端身份没变 → 允许复用本地 state 的块
    const result = await pushLocal({
      remote,
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      remoteId: 'webdav:http://old.example/',
    });

    expect(result.uploadedItems).toBe(1);
    // 整块可复用:只重传尾部的半块
    expect(result.uploadedChunks).toBe(1);
    expect(result.uploadedBytes).toBe(size - 2 * CHUNK);
  });

  it('推送后 state 记住远端身份', async () => {
    const { vault, size } = await setup();
    const state = stateWithPushed('gen1', size);
    const remote = new MemoryRemote();

    await pushLocal({
      remote,
      deviceId: 'dev1',
      vaultRoot: vault,
      state,
      remoteId: 's3:https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/my-bucket',
    });

    expect(state.remoteId).toBe('s3:https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/my-bucket');
  });

  it('同一后端重复推送仍然零重传(不破坏断点续传)', async () => {
    const { vault, size } = await setup();
    const state = stateWithPushed('gen1', size);
    const remote = new MemoryRemote();
    const remoteId = 'webdav:http://old.example/';

    // 第一轮:推上去
    await pushLocal({ remote, deviceId: 'dev1', vaultRoot: vault, state, remoteId });
    expect(remote.files.size).toBeGreaterThan(0);

    // 第二轮:远端索引已有,应零重传
    const before = remote.writes.length;
    const r2 = await pushLocal({ remote, deviceId: 'dev1', vaultRoot: vault, state, remoteId });
    expect(r2.uploadedItems).toBe(0);
    expect(r2.skippedItems).toBe(1);
    expect(remote.writes.length).toBe(before);
  });
});

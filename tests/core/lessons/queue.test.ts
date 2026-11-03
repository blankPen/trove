import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLearnQueue, enqueueLearn, removeLearn } from '../../../src/core/lessons/queue.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lessons-queue-'));
  path = join(dir, 'learn-queue.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('learn 待办队列', () => {
  it('文件缺失或损坏按空队处理', async () => {
    expect(await readLearnQueue(path)).toEqual([]);
    await writeFile(path, '{ 损坏', 'utf8');
    expect(await readLearnQueue(path)).toEqual([]);
  });

  it('enqueueLearn 追加并去重,保留既有顺序', async () => {
    await enqueueLearn(path, ['a', 'b']);
    await enqueueLearn(path, ['b', 'c', 'a']);
    expect(await readLearnQueue(path)).toEqual(['a', 'b', 'c']);
  });

  it('removeLearn 只移除指定项,保留其余', async () => {
    await enqueueLearn(path, ['a', 'b', 'c', 'd']);
    await removeLearn(path, ['b', 'd', 'zzz']);
    expect(await readLearnQueue(path)).toEqual(['a', 'c']);
  });

  it('写入落盘,跨调用持久', async () => {
    await enqueueLearn(path, ['x']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['x']);
    expect(await readLearnQueue(path)).toEqual(['x']);
  });
});
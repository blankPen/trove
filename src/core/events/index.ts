import type { HarnessId } from '../../adapters/index.js';
import { EVENTS_PREFIX, type Event, type MapperFile } from './schema.js';
import { mapClaude } from './claude.js';
import { mapCodex } from './codex.js';
import { mapOpencode } from './opencode.js';
import { mapDoubao } from './doubao.js';

export type Mapper = (files: MapperFile[]) => Event[];

/** 已实现映射的 harness;没有 mapper 的源只保留 raw。 */
const mappers: Partial<Record<HarnessId, Mapper>> = {
  'claude-code': mapClaude,
  codex: mapCodex,
  opencode: mapOpencode,
  doubao: mapDoubao,
};

export function hasMapper(harness: HarnessId): boolean {
  return Boolean(mappers[harness]);
}

/** 把一组 raw 文件映射成事件流(纯函数,供 library 构建使用)。 */
export function mapSession(harness: HarnessId, files: MapperFile[]): Event[] {
  return mappers[harness]?.(files) ?? [];
}

import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { Source } from './types.js';

export const CLAUDE_CODE_ID = 'claude-code';
export const CLAUDE_CODE_ROOT = join(homedir(), '.claude');

/**
 * Claude Code adapter(v1 唯一实现,设计 §8.2)。
 * 纯声明式:只描述搬什么,不含任何同步逻辑。
 */
export function createClaudeCodeSource(root: string = CLAUDE_CODE_ROOT): Source {
  return {
    id: CLAUDE_CODE_ID,
    displayName: 'Claude Code',
    root,
    patterns: [
      'projects/**/*.jsonl', // 会话(106M,核心资产)
      'history.jsonl',
      'skills/**',
      'CLAUDE.md',
      'RTK.md',
      'plans/**',
      'tasks/**',
      'file-history/**',
    ],
    exclusions: [
      'settings.json', // 直接排除而非脱敏(设计 §8.2)
      'plugins/**',
      'downloads/**',
      'telemetry/**',
      'paste-cache/**',
      'backups/**',
      'daemon.log',
      'shell-snapshots/**',
    ],
    mapToVaultPath: (absPath) => join(CLAUDE_CODE_ID, relative(root, absPath)),
  };
}

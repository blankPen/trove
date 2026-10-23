import { homedir } from 'node:os';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import type { FileSourceConfig } from './file-source.js';

export type HarnessId = 'claude-code' | 'codex' | 'opencode' | 'doubao';

export interface FileAdapter {
  kind: 'files';
  id: Exclude<HarnessId, 'opencode'>;
  displayName: string;
  source: FileSourceConfig;
}

export interface OpenCodeAdapter {
  kind: 'opencode';
  id: 'opencode';
  displayName: string;
  dbPath: string;
}

export type Adapter = FileAdapter | OpenCodeAdapter;

export interface AdapterPaths {
  home?: string;
  claudeRoot?: string;
  codexRoot?: string;
  opencodeDb?: string;
  doubaoRoot?: string;
}

/** 豆包 agent mode 工作区(办公版),会话内容在 .sessions/<id> 与 conversation/<id>。 */
function defaultDoubaoRoot(home: string): string {
  return join(
    home,
    'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace',
  );
}

export function claudeCodeAdapter(root: string): FileAdapter {
  return {
    kind: 'files',
    id: 'claude-code',
    displayName: 'Claude Code',
    source: {
      id: 'claude-code',
      displayName: 'Claude Code',
      root,
      // 两套互不重叠的会话存储:projects/*.jsonl 与 transcripts/*.jsonl
      patterns: [
        'projects/**/*.jsonl',
        'transcripts/**/*.jsonl',
        'history.jsonl',
        'skills/**',
        'CLAUDE.md',
        'RTK.md',
        'plans/**',
        'tasks/**',
        // file-history 是编辑器快照(1797 个小文件),不是会话正文;默认不搬

      ],
      exclusions: ['.credentials.json', 'settings.json', 'settings.local.json'],
      sessionPatterns: ['projects/**/*.jsonl', 'transcripts/**/*.jsonl'],
      // 大而无价值的目录:整棵剪掉,不参与遍历
      pruneDirs: [
        'plugins',
        'stats',
        'stats2',
        'stats3',
        'stats4',
        'bash-snapshots',
        'downloads',
        'telemetry',
        'paste-cache',
        'backups',
        'shell-snapshots',
        'sessions',
        'cache',
        'jobs',
        'bin',
        'ide',
        'debug',
        'session-models',
        'token-offsets',
        'hooks',
        'daemon',
      ],
    },
  };
}

export function codexAdapter(root: string): FileAdapter {
  return {
    kind: 'files',
    id: 'codex',
    displayName: 'Codex',
    source: {
      id: 'codex',
      displayName: 'Codex',
      root,
      patterns: [
        'sessions/**/*.jsonl',
        'archived_sessions/**/*.jsonl',
        'history.jsonl',
        'skills/**',
      ],
      // auth.json / config.toml 可能含 API key;SQLite 是运行态缓存,均不归档
      exclusions: ['auth.json', 'config.toml', 'config.toml.bak', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm'],
      sessionPatterns: ['sessions/**/*.jsonl', 'archived_sessions/**/*.jsonl'],
      pruneDirs: ['.tmp', 'tmp', 'log', 'logs', 'shell_snapshots', 'thread-writer-locks'],
    },
  };
}

export function doubaoAdapter(root: string): FileAdapter {
  return {
    kind: 'files',
    id: 'doubao',
    displayName: '豆包',
    source: {
      id: 'doubao',
      displayName: '豆包',
      root,
      // 只收会话内容:board/memory/assignment/trajectory/socket 与后台任务输出。
      // scratch、sandbox、skills 是生成物/技能库,不属于会话正文(体积也占九成)。
      patterns: [
        '.sessions/*/board.md',
        '.sessions/*/memory/**',
        '.sessions/*/agents/*/system/**',
        '.sessions/*/agents/*/socket/**',
        'conversation/**',
      ],
      exclusions: ['**/*.key', '**/*.pem', '**/.env', '**/auth.json', '**/credentials*'],
      sessionPatterns: ['.sessions/**', 'conversation/**'],
      pruneDirs: ['.skills', '.user_skills', 'experience', '**/scratch', '**/sandbox', '**/node_modules'],
      sessionKeyOf: (rel) => {
        const m = /^\.sessions\/([^/]+)\//.exec(rel) ?? /^conversation\/([^/]+)\//.exec(rel);
        return m ? m[1]! : rel;
      },
    },
  };
}

export function opencodeAdapter(dbPath: string): OpenCodeAdapter {
  return { kind: 'opencode', id: 'opencode', displayName: 'OpenCode', dbPath };
}

/** 这个归档项是否属于"会话"(skills/plans 等资产不算会话)。 */
export function isSessionPath(adapter: Adapter, relPath: string): boolean {
  if (adapter.kind === 'opencode') return true;
  const globs = adapter.source.sessionPatterns ?? adapter.source.patterns;
  return globs.some((g) => minimatch(relPath, g, { dot: true }));
}

/**
 * 按本机路径生成四个 adapter;调用方按 config.sources 过滤启用项。
 * 允许用环境变量覆盖根目录,便于测试与迁移:
 * TROVE_CLAUDE_ROOT / TROVE_CODEX_ROOT / TROVE_OPENCODE_DB / TROVE_DOUBAO_ROOT
 */
export function createAdapters(opts: AdapterPaths = {}, env: NodeJS.ProcessEnv = process.env): Adapter[] {
  const home = opts.home ?? homedir();
  return [
    claudeCodeAdapter(opts.claudeRoot ?? env.TROVE_CLAUDE_ROOT ?? join(home, '.claude')),
    codexAdapter(opts.codexRoot ?? env.TROVE_CODEX_ROOT ?? join(home, '.codex')),
    opencodeAdapter(
      opts.opencodeDb ?? env.TROVE_OPENCODE_DB ?? join(home, '.local/share/opencode/opencode.db'),
    ),
    doubaoAdapter(opts.doubaoRoot ?? env.TROVE_DOUBAO_ROOT ?? defaultDoubaoRoot(home)),
  ];
}

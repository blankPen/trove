/** trove MCP server（stdio）：7 个只读查询原语。stdout 只输出 JSON-RPC，日志一律走 stderr。 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseSince } from '../core/time-window.js';
import {
  getLesson,
  getSearchStatus,
  getSession,
  listLessons,
  searchLessons,
  searchSessions,
  type LessonSearchTransport,
  type SearchBackendConfig,
} from '../core/search/service.js';
import {
  formatLesson,
  formatLessonHits,
  formatSearchStatus,
  formatSession,
  formatSessionHits,
  truncateOutput,
} from '../core/search/format.js';
import { formatWhoami, readWhoami, type WhoamiSection } from '../core/whoami.js';

export interface McpOptions {
  vault: string;
  cacheDir: string;
  version: string;
  now?: () => number;
  /** 检索后端配置;缺省表示检索不可用。 */
  backend?: SearchBackendConfig;
  /** 外部检索通道(daemon);缺省本进程加载模型。 */
  transport?: LessonSearchTransport;
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: truncateOutput(text) }] };
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function sinceCutoff(raw: string | undefined, now: () => number): number | undefined {
  if (!raw) return undefined;
  const cutoff = parseSince(raw, now());
  return cutoff ?? undefined;
}

export function createMcpServer(opts: McpOptions): McpServer {
  const { vault, cacheDir, version } = opts;
  const now = opts.now ?? Date.now;
  const server = new McpServer({ name: 'trove', version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'trove_whoami',
    {
      title: '用户画像与偏好',
      description:
        '查询用户是谁、职责/工作背景、编码/写作/对话风格、近期工作方向。适用于「我是谁」「我的偏好」「我最近在做什么」。' +
        '不适用于通用编程问题；默认不返回年龄/人际关系等敏感分区。',
      inputSchema: {
        sections: z
          .array(z.enum(['profile', 'styles', 'recent', 'all']))
          .optional()
          .describe('要返回的分区；默认 profile,styles,recent'),
        full: z.boolean().optional().describe('是否包含年龄/人际关系等敏感分区'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const result = await readWhoami(vault, {
          sections: args.sections as WhoamiSection[] | undefined,
          full: args.full === true,
        });
        return textResult(formatWhoami(result));
      } catch (err) {
        return errorResult(`读取用户信息失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_lessons_search',
    {
      title: '检索经验与记忆',
      description:
        '检索用户沉淀的经验、实体、偏好与决策（lessons）。适用于「以前有没有踩过这个坑」「这个项目/工具的背景」「有没有相关经验」。' +
        '不适用于通用编程问题或当前仓库代码问题；结果不足时再调用 trove_sessions_search。',
      inputSchema: {
        query: z.string().describe('检索词，支持中文与英文；自然语言即可'),
        category: z
          .enum(['preferences', 'entities', 'experiences', 'events', 'resources'])
          .optional()
          .describe('限定类目'),
        type: z.string().optional().describe('限定记忆类型，如 experiences/gotcha'),
        since: z.string().optional().describe('时间窗，如 7d / 90d / 2026-10-01'),
        limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const hits = await searchLessons(
          vault,
          {
            query: args.query,
            ...(args.category ? { category: args.category } : {}),
            ...(args.type ? { type: args.type } : {}),
            ...(args.since ? { since: sinceCutoff(args.since, now) } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
            cwd: process.cwd(),
          },
          opts.backend,
          opts.transport,
        );
        return textResult(formatLessonHits(hits));
      } catch (err) {
        return errorResult(`检索经验失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_lesson_get',
    {
      title: '读取单条经验',
      description:
        '按路径读取一条 lesson 的正文。仅在 trove_lessons_search 的摘要不足时使用；默认截断到 8KB，full=true 最多 64KB。',
      inputSchema: {
        path: z.string().describe('相对 lessons 根的路径，如 experiences/gotcha-xxx.md'),
        section: z.string().optional().describe('只读某个标题小节'),
        lines: z.string().optional().describe('只读行范围，如 1-80'),
        full: z.boolean().optional().describe('读取完整正文（上限 64KB）'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const doc = await getLesson(vault, args.path, {
          ...(args.section ? { section: args.section } : {}),
          ...(args.lines ? { lines: args.lines } : {}),
          ...(args.full !== undefined ? { full: args.full } : {}),
        });
        return doc ? textResult(formatLesson(doc)) : errorResult(`没有找到 lesson：${args.path}`);
      } catch (err) {
        return errorResult(`读取 lesson 失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_lessons_list',
    {
      title: '浏览经验目录',
      description: '按类目/时间浏览 lessons 目录，不针对具体问题。适用于「有哪些经验/最近新增了什么」。',
      inputSchema: {
        category: z
          .enum(['preferences', 'entities', 'experiences', 'events', 'resources'])
          .optional()
          .describe('限定类目'),
        since: z.string().optional().describe('时间窗，如 7d / 90d'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 50'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const hits = await listLessons(vault, {
          ...(args.category ? { category: args.category } : {}),
          ...(args.since ? { since: sinceCutoff(args.since, now) } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });
        return textResult(formatLessonHits(hits));
      } catch (err) {
        return errorResult(`浏览经验失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_sessions_search',
    {
      title: '检索历史会话',
      description:
        '检索本机跨设备、跨 agent 的历史会话。自然语言用默认 FTS；报错码/函数名/路径/commit 等精确标识符用 exact=true。' +
        '只在 lessons 不足或需要现场细节时使用；返回会话 id 后用 trove_session_get 读取片段。',
      inputSchema: {
        query: z.string().describe('检索词；自然语言或精确标识符'),
        harness: z.string().optional().describe('限定工具：claude-code / codex / opencode / doubao'),
        device: z.string().optional().describe('限定设备 id'),
        since: z.string().optional().describe('时间窗，如 7d / 90d / 2026-10-01'),
        limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10'),
        exact: z
          .boolean()
          .optional()
          .describe('精确线性检索（覆盖全部工具输出，较慢 2–5s）；报错码/函数名/路径时使用'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const out = await searchSessions(vault, cacheDir, {
          query: args.query,
          ...(args.harness ? { harness: args.harness } : {}),
          ...(args.device ? { device: args.device } : {}),
          ...(args.since ? { since: sinceCutoff(args.since, now) } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.exact !== undefined ? { exact: args.exact } : {}),
          cwd: process.cwd(),
        });
        return textResult(
          formatSessionHits(out.results, {
            ...(out.stale ? { stale: true } : {}),
            ...(out.degraded ? { degraded: out.degraded } : {}),
          }),
        );
      } catch (err) {
        return errorResult(`检索会话失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_session_get',
    {
      title: '读取会话片段',
      description:
        '按会话 id 读取事件片段。默认返回前 20 条；around 可定位到某段文字附近。只在 trove_sessions_search 命中后使用。',
      inputSchema: {
        session_id: z.string().describe('会话 id（可带 harness: 前缀）'),
        harness: z.string().optional().describe('会话 id 不唯一时限定工具'),
        around: z.string().optional().describe('定位到包含该文字的片段附近'),
        limit: z.number().int().min(1).max(50).optional().describe('返回事件数，默认 20'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const detail = await getSession(vault, cacheDir, args.session_id, {
          ...(args.harness ? { harness: args.harness } : {}),
          ...(args.around ? { around: args.around } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });
        return detail ? textResult(formatSession(detail)) : errorResult(`没有找到会话：${args.session_id}`);
      } catch (err) {
        return errorResult(`读取会话失败：${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'trove_status',
    {
      title: '知识库状态',
      description: '查看会话索引、经验数量与索引新鲜度。回答前若不确定数据是否最新，可先调用。',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const status = await getSearchStatus(vault, cacheDir);
        return textResult(formatSearchStatus(status));
      } catch (err) {
        return errorResult(`读取状态失败：${(err as Error).message}`);
      }
    },
  );

  return server;
}

export async function runMcpServer(opts: McpOptions): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    process.stdin.once('end', done);
  });
  await server.close();
}

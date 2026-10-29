/** Sidecar 分层存储(L0/L1/L2):为 lessons 各目录生成 .abstract.md(L0) 与 .overview.md(L1),自底向上刷新。 */
import type { StorageAdapter } from './storage.js';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';

export interface SidecarDir {
  /** 相对 lessons 根的目录路径;根为 ''。 */
  path: string;
  /** H1 标题(也是该目录的中文名)。 */
  name: string;
  /** 一句话简介(= L0 正文,亦为 L1 的 Brief)。 */
  brief: string;
}

export const SIDECAR_DIRS: SidecarDir[] = [
  { path: '', name: '学习沉淀概览', brief: '从 AI 会话沉淀的可复用经验与偏好，按偏好、实体、经验、决策、资源五类分层组织。' },
  { path: 'preferences', name: '用户偏好', brief: '用户偏好配置库，聚焦用户画像、编码风格、写作风格、对话风格与最近事项等个人偏好，回答时自动套用。' },
  { path: 'entities', name: '实体库', brief: '实体库，卡片式记录项目、人物、组织、工具与技术栈等长期有效的事实。' },
  { path: 'experiences', name: '经验库', brief: '经验库，沉淀调试模式、操作流程、陷阱坑与纠正教训等可复用经验。' },
  { path: 'events', name: '决策记录', brief: '决策记录，归档用户拍板的方向与取舍及当时的背景。' },
  { path: 'resources', name: '资料库', brief: '资料库，收录文档、代码仓库与链接等外部资料。' },
];

const COMPONENT = 'ExtractionPipeline';
const THRESHOLD = 0.1;

/** 各目录下需要稳定列出的子目录(带中文标签);叶子目录(偏好/经验/决策)只列直接文件。 */
const SUBDIRS: Record<string, { name: string; label: string }[]> = {
  '': [
    { name: 'preferences', label: '用户偏好' },
    { name: 'entities', label: '实体库' },
    { name: 'experiences', label: '经验库' },
    { name: 'events', label: '决策记录' },
    { name: 'resources', label: '资料库' },
  ],
  entities: [
    { name: 'projects', label: '项目' },
    { name: 'people', label: '人物' },
    { name: 'organizations', label: '组织' },
    { name: 'tools', label: '工具' },
    { name: 'tech', label: '技术栈' },
  ],
  resources: [
    { name: 'docs', label: '文档' },
    { name: 'repos', label: '仓库' },
    { name: 'links', label: '链接' },
  ],
};

interface SidecarMeta {
  component: string;
  trigger: string;
  totalEntries: number;
  pendingChildChanges: number;
  updatedAt: string;
}

function joinRel(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

function directoryField(path: string): string {
  return path ? `lessons/${path}/` : 'lessons/';
}

function sidecarDir(path: string): SidecarDir {
  return SIDECAR_DIRS.find((d) => d.path === path)!;
}

/** 从 L1 提取 Brief(H1 之后、首个 ## 之前的那段话),作为 L0 正文的唯一来源。 */
export function extractBrief(overviewText: string): string {
  const body = stripFrontmatter(overviewText) ?? overviewText;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === '' || lines[i]!.startsWith('# '))) i++;
  const out: string[] = [];
  while (i < lines.length && !lines[i]!.startsWith('##')) {
    out.push(lines[i]!);
    i++;
  }
  return out.join('\n').trim();
}

/** 强制重建根 + 5 大类目录的 sidecar;返回写入的相对路径。 */
export async function refreshSidecars(
  storage: StorageAdapter,
  opts: { trigger?: string; now?: () => Date } = {},
): Promise<string[]> {
  const written: string[] = [];
  // 自底向上:叶子类目录在前,根在后。
  for (const d of [...SIDECAR_DIRS].reverse()) {
    written.push(...(await refreshOne(storage, d, opts)));
  }
  return written;
}

/** 写入记忆后标记目录变脏:L0/L1 未跨 10% 阈值时只递增 pending,否则整目录刷新。 */
export async function touchSidecars(
  storage: StorageAdapter,
  dirPaths: string[],
  opts: { trigger?: string; now?: () => Date } = {},
): Promise<string[]> {
  const written: string[] = [];
  for (const p of dirPaths) {
    const d = sidecarDir(p);
    const overviewPath = joinRel(p, '.overview.md');
    const existing = await storage.read(overviewPath);
    if (existing === null) {
      written.push(...(await refreshOne(storage, d, opts)));
      continue;
    }
    const pending = fieldInt(existing, 'pending_child_changes') + 1;
    const total = fieldInt(existing, 'total_entries');
    if (total === 0 || pending / total >= THRESHOLD) {
      written.push(...(await refreshOne(storage, d, opts)));
    } else {
      await storage.write(overviewPath, setField(existing, 'pending_child_changes', pending));
      written.push(overviewPath);
    }
  }
  return written;
}

async function refreshOne(storage: StorageAdapter, d: SidecarDir, opts: { trigger?: string; now?: () => Date }): Promise<string[]> {
  const nav = await buildNav(storage, d);
  const meta: SidecarMeta = {
    component: COMPONENT,
    trigger: opts.trigger ?? 'manual_refresh',
    totalEntries: nav.length,
    pendingChildChanges: 0,
    updatedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  const overviewPath = joinRel(d.path, '.overview.md');
  const abstractPath = joinRel(d.path, '.abstract.md');
  const overview = renderOverview(d, nav, meta);
  const abstract = renderAbstract(d, overview, meta);
  await storage.write(overviewPath, overview);
  await storage.write(abstractPath, abstract);
  return [overviewPath, abstractPath];
}

async function buildNav(storage: StorageAdapter, d: SidecarDir): Promise<string[]> {
  const lines: string[] = [];
  for (const sub of SUBDIRS[d.path] ?? []) {
    const count = (await storage.list(joinRel(d.path, sub.name))).filter((f) => !isSidecarOrIndex(f)).length;
    lines.push(`- \`${sub.name}/\`: ${sub.label}（${count} 个文件）`);
  }
  for (const f of await directFiles(storage, d.path)) {
    lines.push(`- \`${f}\`: ${await describeFile(storage, joinRel(d.path, f))}`);
  }
  return lines;
}

async function directFiles(storage: StorageAdapter, path: string): Promise<string[]> {
  const files = await storage.list(path);
  const prefix = path ? `${path}/` : '';
  const out: string[] = [];
  for (const f of files) {
    const rel = prefix ? (f.startsWith(prefix) ? f.slice(prefix.length) : '') : f;
    if (!rel || rel.startsWith('.') || rel === 'INDEX.md' || rel === 'README.md' || rel.includes('/') || !rel.endsWith('.md')) continue;
    out.push(rel);
  }
  return out.sort();
}

async function describeFile(storage: StorageAdapter, path: string): Promise<string> {
  const text = (await storage.read(path)) ?? '';
  const title = parseFrontmatter(text)?.title;
  if (title) return title;
  const body = stripFrontmatter(text) ?? text;
  const first = body.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function isSidecarOrIndex(path: string): boolean {
  const base = path.split('/').pop()!;
  return base === '.abstract.md' || base === '.overview.md' || base === 'INDEX.md';
}

function renderOverview(d: SidecarDir, nav: string[], meta: SidecarMeta): string {
  return (
    renderSidecarFrontmatter(directoryField(d.path), meta) +
    `# ${d.name}\n\n${d.brief}\n\n## Quick Navigation\n${nav.join('\n')}\n`
  );
}

function renderAbstract(d: SidecarDir, overview: string, meta: SidecarMeta): string {
  return renderSidecarFrontmatter(directoryField(d.path), meta) + `${extractBrief(overview)}\n`;
}

function renderSidecarFrontmatter(directory: string, meta: SidecarMeta): string {
  return [
    '---',
    `directory: ${directory}`,
    'generated_by:',
    `  component: ${meta.component}`,
    `  trigger: ${meta.trigger}`,
    'freshness:',
    `  total_entries: ${meta.totalEntries}`,
    `  pending_child_changes: ${meta.pendingChildChanges}`,
    `updated_at: ${meta.updatedAt}`,
    '---',
    '',
  ].join('\n');
}

function fieldInt(text: string, key: string): number {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm'));
  return m ? Number(m[1]) : 0;
}

function setField(text: string, key: string, value: number): string {
  return text.replace(new RegExp(`^(\\s*${key}:)\\s*\\d+\\s*$`, 'm'), `$1 ${value}`);
}
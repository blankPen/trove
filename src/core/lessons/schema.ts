/** 17 类记忆类型的 Schema 定义与校验。类型标识 key 统一用复数目录前缀(0.2 口径)。 */

export type MergeOp = 'add' | 'patch' | 'append';

export interface MemoryTypeSchema {
  /** 唯一标识,如 `experiences/debug_pattern`。 */
  key: string;
  /** 一级目录,用于 INDEX 分区:preferences/entities/experiences/events/resources。 */
  category: string;
  /** 相对 lessons 根的文件名模板,含 `{slug}`/`{name}` 占位符或 `YYYY-MM-DD`。 */
  filename: string;
  mergeOp: MergeOp;
  /** 提取提示词,引用 `{summary}`/`{events}` 占位符。 */
  extractionPrompt: string;
  /** 合并提示词,仅 patch 类需要,引用 `{summary}`/`{existing}`。 */
  mergePrompt?: string;
}

function ex(kind: string): string {
  return `从会话 {summary} 与事件 {events} 中提取 ${kind} 相关记忆。`;
}
function merge(kind: string): string {
  return `把新提取的 ${kind} 相关 {summary} 合并进现有 {existing},去重、冲突以新为准、保留 evidence。`;
}

const DEFS: MemoryTypeSchema[] = [
  // 偏好 5 类(patch 合并到固定文件):画像聚焦「当前使用用户」,其余各司其职
  { key: 'preferences/profile', category: 'preferences', filename: 'preferences/profile.md', mergeOp: 'patch', extractionPrompt: '围绕「当前使用用户」做用户画像:提取用户信息,覆盖 我是谁(姓名/身份)、年龄、职责(岗位/角色)、工作背景(经历/技术方向)、人际关系(同事/上下级/合作方)。只写会话中真实出现且确定的信息,推断或空值不写。', mergePrompt: '把新提取的用户画像 {summary} 合并进现有 {existing}:按 我是谁/年龄/职责/工作背景/人际关系 补齐缺失维度,同维度以新为准,去重并保留 evidence,不丢既有有效信息。' },
  { key: 'preferences/coding_style', category: 'preferences', filename: 'preferences/coding_style.md', mergeOp: 'patch', extractionPrompt: '编码风格:用户偏好的代码规范、命名、注释、语言/框架取舍与工程习惯(测试、类型、目录结构等)。', mergePrompt: merge('编码风格') },
  { key: 'preferences/writing_style', category: 'preferences', filename: 'preferences/writing_style.md', mergeOp: 'patch', extractionPrompt: '写作风格:用户偏好的语言(简体中文等)、语气、排版、用词与行文习惯。', mergePrompt: merge('写作风格') },
  { key: 'preferences/dialogue_style', category: 'preferences', filename: 'preferences/dialogue_style.md', mergeOp: 'patch', extractionPrompt: '对话风格:用户对 AI 回复的称呼、口吻、详略与格式(列表/代码块、是否解释步骤)等偏好。', mergePrompt: merge('对话风格') },
  { key: 'preferences/recent_matters', category: 'preferences', filename: 'preferences/recent_matters.md', mergeOp: 'patch', extractionPrompt: '最近事项:用户近期正在推进的工作、关注的问题、待办与当前项目。只保留近期/当前有效的,已完成或过期的不写。', mergePrompt: '把新提取的最近事项 {summary} 合并进现有 {existing}:以新为准,已完成/过期的旧事项可移除,保持「近期」时效,去重并保留 evidence。' },
  // 实体 5 类(卡片式,同名合并)
  { key: 'entities/project', category: 'entities', filename: 'entities/projects/{slug}/overview.md', mergeOp: 'patch', extractionPrompt: ex('项目'), mergePrompt: merge('项目') },
  { key: 'entities/people', category: 'entities', filename: 'entities/people/{name}.md', mergeOp: 'patch', extractionPrompt: ex('人物'), mergePrompt: merge('人物') },
  { key: 'entities/organization', category: 'entities', filename: 'entities/organizations/{name}.md', mergeOp: 'patch', extractionPrompt: ex('组织'), mergePrompt: merge('组织') },
  { key: 'entities/tool', category: 'entities', filename: 'entities/tools/{name}.md', mergeOp: 'patch', extractionPrompt: ex('工具'), mergePrompt: merge('工具') },
  { key: 'entities/tech', category: 'entities', filename: 'entities/tech/{name}.md', mergeOp: 'patch', extractionPrompt: ex('技术栈'), mergePrompt: merge('技术栈') },
  // 经验 4 类(debug/gotcha/correction 独立 add;workflow 合并 patch)
  { key: 'experiences/debug_pattern', category: 'experiences', filename: 'experiences/debug-{slug}.md', mergeOp: 'add', extractionPrompt: ex('调试模式(错误现象→根因→解法)') },
  { key: 'experiences/workflow', category: 'experiences', filename: 'experiences/workflow-{slug}.md', mergeOp: 'patch', extractionPrompt: ex('操作流程'), mergePrompt: merge('操作流程') },
  { key: 'experiences/gotcha', category: 'experiences', filename: 'experiences/gotcha-{slug}.md', mergeOp: 'add', extractionPrompt: ex('陷阱坑') },
  { key: 'experiences/correction', category: 'experiences', filename: 'experiences/correction-{slug}.md', mergeOp: 'add', extractionPrompt: ex('纠正教训(用户纠正了 AI 什么)') },
  // 决策 1 类(add 独立,不合并)
  { key: 'events/decision', category: 'events', filename: 'events/YYYY-MM-DD-decided-{slug}.md', mergeOp: 'add', extractionPrompt: ex('决策(用户拍板的方向/取舍)') },
  // 资源 3 类(append 追加,不去重)
  { key: 'resources/doc', category: 'resources', filename: 'resources/docs/{slug}.md', mergeOp: 'append', extractionPrompt: ex('文档资源') },
  { key: 'resources/repo', category: 'resources', filename: 'resources/repos/{slug}.md', mergeOp: 'append', extractionPrompt: ex('代码仓库资源') },
  { key: 'resources/link', category: 'resources', filename: 'resources/links/{slug}.md', mergeOp: 'append', extractionPrompt: ex('链接资源') },
];

export function validateMemoryTypes(defs: MemoryTypeSchema[]): void {
  for (const d of defs) {
    if (!d.key || !d.category || !d.filename || !d.mergeOp) {
      throw new Error(`Memory Schema 缺字段:${JSON.stringify(d)}`);
    }
    if (!d.extractionPrompt) throw new Error(`缺少提取提示词:${d.key}`);
    if (d.mergeOp === 'patch' && !d.mergePrompt) throw new Error(`缺少合并提示词:${d.key}`);
  }
}

export function listMemoryTypes(): MemoryTypeSchema[] {
  validateMemoryTypes(DEFS);
  return DEFS;
}

export function getMemoryType(key: string): MemoryTypeSchema | undefined {
  return listMemoryTypes().find((t) => t.key === key);
}

/** 语义化 slug:小写、非法字符折成 `-`,保留 Unicode 字母数字(中文)。 */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s || 'item';
}

export function buildFilename(
  schema: MemoryTypeSchema,
  opts: { title?: string; slug?: string; name?: string; date?: string } = {},
): string {
  const slug = opts.slug ?? slugify(opts.title ?? '');
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return schema.filename
    .replace(/\{slug\}/g, slug)
    .replace(/\{name\}/g, opts.name ?? slug)
    .replace(/YYYY-MM-DD/g, date);
}
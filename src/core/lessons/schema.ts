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
  { key: 'preferences/recent_matters', category: 'preferences', filename: 'preferences/recent_matters.md', mergeOp: 'patch', extractionPrompt: '最近事项:由跨会话聚合(recent.ts)按时间+项目+主题生成,不走单会话提取。', mergePrompt: '根据最近会话清单 {summary} 重写用户近期工作方向 {existing}。清单按会话时间倒序,每行含 日期|项目(cwd)|主题|频繁度(同类会话数·首次~最近时间·事件条数)。据此把近期事项分三档组织:①持续方向(同项目反复出现,同类≥2次或时间跨度长,长期推进);②近期一次性(仅1次、规模小,临时问题);③高优先级(对公司业务或个人很重要:上线、事故、决策、面试、健康、家庭等,结合主题文本判断重要性)。每档内按讨论频繁度与最近时间排序;已完成或久未出现的旧方向可移除,保持「近期」时效。' },
  // 实体 5 类(卡片式,同名合并)
  { key: 'entities/project', category: 'entities', filename: 'entities/projects/{slug}/overview.md', mergeOp: 'patch', extractionPrompt: ex('项目'), mergePrompt: merge('项目') },
  { key: 'entities/people', category: 'entities', filename: 'entities/people/{name}.md', mergeOp: 'patch', extractionPrompt: ex('人物'), mergePrompt: merge('人物') },
  { key: 'entities/organization', category: 'entities', filename: 'entities/organizations/{name}.md', mergeOp: 'patch', extractionPrompt: ex('组织'), mergePrompt: merge('组织') },
  { key: 'entities/tool', category: 'entities', filename: 'entities/tools/{name}.md', mergeOp: 'patch', extractionPrompt: ex('工具'), mergePrompt: merge('工具') },
  { key: 'entities/tech', category: 'entities', filename: 'entities/tech/{name}.md', mergeOp: 'patch', extractionPrompt: ex('技术栈'), mergePrompt: merge('技术栈') },
  // 经验 4 类(debug/gotcha/correction 独立 add;workflow 合并 patch)
  { key: 'experiences/debug_pattern', category: 'experiences', filename: 'experiences/debug-{slug}.md', mergeOp: 'add', extractionPrompt: '按「错误现象→根因→修复→边界」四步:错误现象给出可搜索的错误串/日志原文;根因说明触发机制;修复给出可执行命令或代码;边界说明适用前提与不适用场景。证据须含错误原文与修复命令。' },
  { key: 'experiences/workflow', category: 'experiences', filename: 'experiences/workflow-{slug}.md', mergeOp: 'patch', extractionPrompt: '按「触发→前置条件→步骤→验证→失败分支」:触发说明何时执行,前置条件列出所需环境,步骤给出工具/命令,验证给出可观察结果,失败分支给出常见失败与兜底。证据至少一条成功命令/工具结果。', mergePrompt: merge('操作流程') },
  { key: 'experiences/gotcha', category: 'experiences', filename: 'experiences/gotcha-{slug}.md', mergeOp: 'add', extractionPrompt: '按「触发条件→为什么踩(机制)→规避动作」:触发条件说明何时中招,机制说明根因,规避动作给出 DON\'T(不要做什么)与 DO(该做什么)。证据须含踩坑错误原文。' },
  { key: 'experiences/correction', category: 'experiences', filename: 'experiences/correction-{slug}.md', mergeOp: 'add', extractionPrompt: '按「用户纠正了什么→AI 原来错在哪→正确做法→以后何时应用」:记录用户纠正的原话、AI 被纠正前的错误说法、正确做法、以及以后何时应用这条纠正。证据须含用户纠正原话与修正验证。' },
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
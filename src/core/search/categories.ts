/** lessons 的 5 个记忆类目与类目描述：qmd collection 上下文与云端嵌入共用。 */

export const LESSON_CATEGORIES = ['preferences', 'entities', 'experiences', 'events', 'resources'] as const;

/** 每个类目一段人写描述：补文档语义，是召回质量影响最大的手段之一。 */
export const CATEGORY_CONTEXT: Record<(typeof LESSON_CATEGORIES)[number], string> = {
  preferences: '用户偏好与长期约定：用户是谁、沟通与编码风格、要求怎么做事。',
  entities: '项目、工具与技术实体档案：仓库、服务、配置项、第三方 API 的事实记录。',
  experiences: '可复用的经验做法：踩过的坑、验证过的做法、适用场景与边界反例。',
  events: '按时间发生的事件与变更：发布、事故、决策及其影响。',
  resources: '外部资料索引：文档、仓库、文章的链接与要点摘要。',
};
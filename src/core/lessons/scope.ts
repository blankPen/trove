/** 项目 scope:经验/事件/资源按项目隔离,偏好/实体全局。slug 只允许 [A-Za-z0-9._-],非法折 _。 */

/** 取路径最后一段,非 [A-Za-z0-9._-] 折成 `_`;空回退 `''`。 */
export function projectSlug(project: string): string {
  const last = project.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** preferences/*、entities/* → global;experiences/events/resources(及其它)→ project:<slug>,slug 为空回退 global。 */
export function inferScope(type: string, project: string): string {
  const top = type.split('/')[0];
  if (top === 'preferences' || top === 'entities') return 'global';
  const slug = projectSlug(project);
  return slug ? `project:${slug}` : 'global';
}

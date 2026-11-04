/** CLI 与 MCP 共用的检索结果格式化；所有输出按 16KB/64KB 上限截断。 */
import type { LessonDoc, LessonHit } from './lessons-index.js';
import type { SessionDetail, SessionHit } from './sessions-index.js';
import type { SearchStatus } from './service.js';

export function truncateOutput(text: string, max = 16_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

export function formatLessonHits(hits: LessonHit[]): string {
  if (!hits.length) return '没有匹配的经验/记忆。';
  const lines = hits.map((h, i) => {
    const meta = [h.type, h.updatedAt?.slice(0, 10)].filter(Boolean).join(' · ');
    return [
      `${i + 1}. **${h.title}**`,
      `   \`${h.path}\`${meta ? ` · ${meta}` : ''}`,
      h.snippet ? `   ${h.snippet}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return truncateOutput(lines.join('\n\n'));
}

export function formatLesson(doc: LessonDoc & { body: string; truncated?: boolean }): string {
  const head = `# ${doc.title}\n\n\`${doc.path}\` · ${doc.type || '未分类'}`;
  return truncateOutput(`${head}\n\n${doc.body}`, 64_000);
}

function displayTitle(title: string | undefined, cwd: string | undefined): string {
  const raw = (title ?? '').trim();
  const noisy =
    !raw ||
    raw.startsWith('<') ||
    raw.startsWith('Caveat:') ||
    raw.toLowerCase().startsWith('this session is being continued');
  if (noisy) {
    const project = cwd?.split('/').filter(Boolean).pop();
    return project ? `${project}（无标题）` : '（无标题）';
  }
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

export function formatSessionHits(
  hits: SessionHit[],
  opts: { stale?: boolean; degraded?: string } = {},
): string {
  const notes = [
    opts.degraded === 'no_index' ? '索引尚未构建，已退回线性检索；运行 trove index build 可提速。' : '',
    opts.stale ? '索引落后于 vault，结果可能缺少最新会话；运行 trove index build 更新。' : '',
  ].filter(Boolean);
  if (!hits.length) return ['没有匹配的会话。', ...notes].join('\n\n');
  const lines = hits.map((h, i) => {
    const when = h.startedAt ? h.startedAt.replace('T', ' ').slice(0, 16) : '时间未知';
    const meta = [when, h.harness, h.cwd].filter(Boolean).join(' · ');
    return [
      `${i + 1}. **${displayTitle(h.title, h.cwd)}**`,
      `   \`${h.session}\` · ${meta}`,
      h.snippet ? `   ${h.snippet}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return truncateOutput([...lines, ...notes].join('\n\n'));
}

export function formatSession(detail: SessionDetail): string {
  const head = [
    `# ${displayTitle(detail.title, detail.cwd)}`,
    `\`${detail.session}\` · ${detail.harness} · ${detail.cwd ?? ''}`.trim(),
    `文件：\`${detail.path}\``,
  ].join('\n');
  const events = detail.events.map((e) => {
    const who = e.role ? ` ${e.role}` : '';
    return `- [${e.seq}] ${e.kind}${who}: ${e.text || '(空)'}`;
  });
  return truncateOutput(`${head}\n\n${events.join('\n')}`, 64_000);
}

export function formatSearchStatus(status: SearchStatus): string {
  const s = status.sessions;
  const lines = [
    `会话索引：${s.indexedSessions}/${s.totalSessions} 已索引${s.stale ? '（过期）' : ''}`,
    `索引体积：${(s.sizeBytes / 1024 / 1024).toFixed(1)} MB` + (s.builtAt ? ` · 构建于 ${s.builtAt}` : ''),
    `经验/记忆：${status.lessons.total} 条（偏好 ${status.lessons.preferences} / 实体 ${status.lessons.entities} / 经验 ${status.lessons.experiences} / 决策 ${status.lessons.events} / 资源 ${status.lessons.resources}）`,
  ];
  if (status.degraded === 'no_index') lines.push('索引尚未构建：运行 trove index build。');
  return lines.join('\n');
}

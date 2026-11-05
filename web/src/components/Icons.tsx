/** 16px 描边图标,一套,灰。不用图标方块、不用彩色底。 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Base({ children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 总览:四格 */
export function IconOverview(p: P) {
  return (
    <Base {...p}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
    </Base>
  );
}

/** 会话:一段转录 */
export function IconSessions(p: P) {
  return (
    <Base {...p}>
      <path d="M4 5h16" />
      <path d="M4 10h11" />
      <path d="M4 15h16" />
      <path d="M4 20h7" />
    </Base>
  );
}

/** 沉淀:叠起来的卡片 */
export function IconLessons(p: P) {
  return (
    <Base {...p}>
      <path d="M12 3.5 3 8l9 4.5L21 8l-9-4.5Z" />
      <path d="m3 12 9 4.5L21 12" />
      <path d="m3 16 9 4.5L21 16" />
    </Base>
  );
}

/** 技能:一个装着文件的夹 */
export function IconSkills(p: P) {
  return (
    <Base {...p}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z" />
      <path d="m10.5 13 1.8 1.8L15 12" />
    </Base>
  );
}

/** 用量:三根柱子 */
export function IconUsage(p: P) {
  return (
    <Base {...p}>
      <path d="M4 20V11" />
      <path d="M10 20V4" />
      <path d="M16 20v-6" />
      <path d="M21 20H3" />
    </Base>
  );
}

/** Inbox:一个收件托盘 */
export function IconInbox(p: P) {
  return (
    <Base {...p}>
      <path d="M3 13.5 5 5h14l2 8.5" />
      <path d="M3 13.5h5l2 3h4l2-3h5" />
      <path d="M5 19h14" />
    </Base>
  );
}

/** 健康:一条脉搏线 */
export function IconHealth(p: P) {
  return (
    <Base {...p}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </Base>
  );
}

/** 刷新 */
export function IconRefresh(p: P) {
  return (
    <Base {...p}>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 4v7h-7" />
    </Base>
  );
}

/** 放大的镜:深搜 */
export function IconSearch(p: P) {
  return (
    <Base {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </Base>
  );
}

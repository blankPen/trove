import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import Mark from './Mark.tsx';
import {
  IconLessons,
  IconOverview,
  IconSessions,
  IconSkills,
  IconUsage,
} from './Icons.tsx';
import { ago } from '../lib/format.ts';

export interface ShellProps {
  deviceName: string;
  daemonRunning: boolean;
  lastRunAt?: number;
}

const NAV = [
  { to: '/', label: '总览', Icon: IconOverview, end: true },
  { to: '/sessions', label: '会话', Icon: IconSessions, end: false },
  { to: '/lessons', label: '沉淀', Icon: IconLessons, end: false },
  { to: '/skills', label: '技能', Icon: IconSkills, end: false },
  { to: '/usage', label: '用量', Icon: IconUsage, end: false },
];

export default function Shell({ deviceName, daemonRunning, lastRunAt }: ShellProps) {
  return (
    <div className="app">
      <nav className="sidebar" aria-label="主导航">
        <div className="wordmark">
          <Mark />
          <b>trove</b>
        </div>
        <div className="scope">{deviceName}</div>
        <div className="nav">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-item">
              <Icon />
              {label}
            </NavLink>
          ))}
        </div>
        <div className="bottom">
          <span
            className={`pill${daemonRunning ? ' pos' : ''}`}
            style={{ marginLeft: 8, height: 20 }}
          >
            <i className="dot" />
            {daemonRunning ? 'daemon 运行中' : 'daemon 未运行'}
          </span>
          <div className="scope" style={{ marginTop: 7 }}>
            {daemonRunning ? `上次同步 ${ago(lastRunAt)}` : '归档不会自动更新'}
          </div>
        </div>
      </nav>
      <main className="canvas">
        <Outlet />
      </main>
    </div>
  );
}

/** 页头:标题 + 一句关于数据的说明 + 右侧动作。 */
export function TitleRow({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="title-row">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="title-actions">{actions}</div> : null}
    </div>
  );
}

/** 一个卡片。 */
export function Panel({
  title,
  meta,
  action,
  children,
  span,
  className,
}: {
  title?: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  span?: number;
  className?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} style={span ? { gridColumn: `span ${span}` } : undefined}>
      {title ? (
        <header>
          <h2>{title}</h2>
          {action ?? (meta ? <span className="meta">{meta}</span> : null)}
        </header>
      ) : null}
      {children}
    </section>
  );
}

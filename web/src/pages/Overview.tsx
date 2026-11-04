import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel, TitleRow } from '../components/Shell.tsx';
import { api, syncStream, type Overview } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { ago, bytes, dateTime, duration, n } from '../lib/format.ts';
import { IconRefresh } from '../components/Icons.tsx';

/** 同步作业在前端的表现:阶段 + 当前项 + 进度条。 */
interface SyncState {
  running: boolean;
  phase?: string;
  detail?: string;
  label?: string;
  current?: number;
  total?: number;
  error?: string;
  done?: boolean;
  result?: string;
}

export default function Overview() {
  const overview = useAsync(() => api.overview(), []);
  const recent = useAsync(() => api.sessions({ limit: 4 }), []);
  const [sync, setSync] = useState<SyncState>({ running: false });
  const [restarting, setRestarting] = useState(false);

  async function startSync() {
    setSync({ running: true });
    try {
      const { jobId } = await api.startSync();
      syncStream(jobId, (type, data) => {
        if (type === 'phase') {
          setSync((s) => ({ ...s, running: true, phase: data['name'] as string, detail: data['detail'] as string }));
        } else if (type === 'item') {
          setSync((s) => ({
            ...s,
            label: data['label'] as string,
            current: data['current'] as number,
            total: data['total'] as number,
          }));
        } else if (type === 'locked') {
          setSync((s) => ({ ...s, phase: '等待 daemon 释放锁', detail: `pid ${data['pid']}` }));
        } else if (type === 'done') {
          setSync((s) => ({ ...s, running: false, done: true, result: '同步完成', phase: undefined }));
          overview.reload();
          recent.reload();
        } else if (type === 'error') {
          setSync((s) => ({ ...s, running: false, error: data['message'] as string }));
        }
      });
    } catch (e) {
      setSync({ running: false, error: (e as Error).message });
    }
  }

  return (
    <>
      <TitleRow
        title="归档"
        sub={<SubLine overview={overview.data} />}
        actions={
          <button className="btn primary" onClick={startSync} disabled={sync.running}>
            {sync.running ? '同步中…' : '立即同步'}
          </button>
        }
      />

      <Kpis overview={overview.data} />

      <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
        <Panel title="每天归档的会话数" meta="最近 30 天" span={8}>
          <PerDayChart overview={overview.data} />
        </Panel>
        <Panel title="同步" span={4}>
          <SyncPanel
            overview={overview.data}
            sync={sync}
            restarting={restarting}
            onRestart={async () => {
              setRestarting(true);
              try {
                await api.restartDaemon();
                overview.reload();
              } finally {
                setRestarting(false);
              }
            }}
          />
        </Panel>
      </div>

      <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
        <Panel
          title="最近的会话"
          span={8}
          action={
            <Link className="card-link" to="/sessions">
              全部会话
            </Link>
          }
        >
          <RecentSessions data={recent.data} loading={recent.loading} />
        </Panel>
        <Panel title="沉淀的分布" meta="按五类" span={4}>
          <LessonMix overview={overview.data} />
          <div
            className="stamp"
            style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>共 {n(overview.data?.counts.lessons ?? 0)} 条</span>
            <Link className="card-link" to="/lessons">
              查看沉淀
            </Link>
          </div>
        </Panel>
      </div>
    </>
  );
}

function SubLine({ overview }: { overview?: Overview }) {
  if (!overview) return '读取中…';
  const st = overview.daemon.status;
  const last = st?.lastRunAt ? `上次同步 ${ago(st.lastRunAt)}` : '尚未同步过';
  return (
    <>
      {n(overview.counts.sessions)} 次会话 · {n(overview.counts.events)} 条事件 ·{' '}
      {n(overview.counts.lessons)} 条记忆 · {last}
    </>
  );
}

function Kpis({ overview }: { overview?: Overview }) {
  const cells: Array<[string, string, string?]> = overview
    ? [
        ['会话', n(overview.counts.sessions)],
        ['事件', n(overview.counts.events)],
        ['记忆', n(overview.counts.lessons)],
        ['技能', n(overview.counts.skills)],
        ['待同步', n(overview.pending.raw.files + overview.pending.library.sessions.files)],
      ]
    : [];
  return (
    <div className="kpis">
      {cells.map(([label, value, unit]) => (
        <div className="kpi" key={label}>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value num">
            {value}
            {unit ? <small>{unit}</small> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 逐日柱状图。牌面的动作:只有今天带强调色,其余是中性墨色。 */
function PerDayChart({ overview }: { overview?: Overview }) {
  const ref = useRef<HTMLDivElement>(null);
  const perDay = overview?.counts.perDay;
  useEffect(() => {
    if (!ref.current || !perDay) return;
    let cancelled = false;
    void import('../charts.js').then((m) => {
      if (cancelled || !ref.current) return;
      const labels = perDay.map((d) => d.date.slice(5));
      const values = perDay.map((d) => d.count);
      // x 轴只标 4~8 个刻度,首尾拉进来;窄屏少标,免得标签叠在一起
      const wide = (ref.current.clientWidth ?? 600) >= 520;
      const step = Math.ceil(labels.length / (wide ? 6 : 3));
      const xAt = labels.map((_, i) => i).filter((i) => i % step === 0 || i === labels.length - 1);
      m.default.bars(ref.current, {
        labels,
        values,
        highlight: values.length - 1,
        height: 196,
        xAt,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [perDay]);

  if (!perDay) return <div className="skeleton" style={{ height: 196 }} />;
  return <div className="chart" ref={ref} />;
}

function SyncPanel({
  overview,
  sync,
  onRestart,
  restarting,
}: {
  overview?: Overview;
  sync: SyncState;
  onRestart: () => void;
  restarting: boolean;
}) {
  const st = overview?.daemon.status;
  const pending = overview
    ? overview.pending.raw.files + overview.pending.library.sessions.files
    : 0;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`pill${overview?.daemon.running ? ' pos' : ''}`}>
          <i className="dot" />
          {overview?.daemon.running ? 'daemon 运行中' : 'daemon 未运行'}
        </span>
        {st?.pid ? <span className="stamp num">pid {st.pid}</span> : null}
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0 }}>
        <dt className="stamp">上次同步</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
          {st?.lastRunAt ? ago(st.lastRunAt) : '—'}
        </dd>
        <dt className="stamp">耗时</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
          {duration(st?.lastDurationMs)}
        </dd>
        <dt className="stamp">下次约</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
          {st?.nextRunAt ? `${Math.max(0, Math.round((st.nextRunAt - Date.now()) / 1000))} 秒后` : '—'}
        </dd>
        <dt className="stamp">待同步</dt>
        <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
          {n(pending)} 个文件
        </dd>
        <dt className="stamp">远端</dt>
        <dd
          className="truncate"
          style={{ margin: 0, textAlign: 'right', color: 'var(--muted)' }}
          title={overview?.remote.desc}
        >
          {overview?.remote.desc}
        </dd>
      </dl>
      {sync.running ? (
        <div className="progress">
          <div className="phase">
            {sync.phase ?? '同步中'}
            {sync.detail ? <span className="stamp"> · {sync.detail}</span> : null}
          </div>
          {sync.total ? (
            <div className="bar">
              <i style={{ width: `${Math.round(((sync.current ?? 0) / sync.total) * 100)}%` }} />
            </div>
          ) : null}
          {sync.label ? (
            <div className="item mono truncate">
              {sync.current}/{sync.total} {sync.label}
            </div>
          ) : null}
        </div>
      ) : null}
      {sync.error ? <div className="pill neg">{sync.error}</div> : null}
      {sync.done ? <div className="pill pos">同步完成</div> : null}
      {st?.lastError ? <div className="pill neg truncate">{st.lastError}</div> : null}
      <button className="btn" onClick={onRestart} disabled={restarting}>
        <IconRefresh width={15} height={15} />
        {restarting ? '重启中…' : '重启 daemon'}
      </button>
    </div>
  );
}

/** 五类记忆的数量排行:细灰条,最大的一项用墨色。 */
function LessonMix({ overview }: { overview?: Overview }) {
  const ref = useRef<HTMLDivElement>(null);
  const mix = overview?.counts.lessonsByCategory;
  const labels: Record<string, string> = {
    preferences: '偏好',
    entities: '实体',
    experiences: '经验',
    events: '决策',
    resources: '资源',
  };
  const rows = useMemo(() => {
    if (!mix) return [];
    return Object.entries(mix)
      .map(([k, v]) => ({ label: labels[k] ?? k, value: v }))
      .sort((a, b) => b.value - a.value);
  }, [mix]);

  useEffect(() => {
    if (!ref.current || !rows.length) return;
    let cancelled = false;
    void import('../charts.js').then((m) => {
      if (cancelled || !ref.current) return;
      m.default.barList(ref.current, rows);
    });
    return () => {
      cancelled = true;
    };
  }, [rows]);

  if (!rows) return <div className="skeleton" style={{ height: 140 }} />;
  if (!rows.length) return <div className="empty">还没有沉淀任何记忆</div>;
  return <div className="chart" ref={ref} />;
}

function RecentSessions({
  data,
  loading,
}: {
  data?: {
    items: Array<{
      harness: string;
      session: string;
      title?: string;
      firstText?: string;
      cwd?: string;
      startedAt?: string;
      events: number;
      bytes: number;
    }>;
  };
  loading: boolean;
}) {
  if (loading) return <div className="skeleton" style={{ height: 180 }} />;
  const items = data?.items ?? [];
  if (!items.length) {
    return (
      <div className="empty">
        <div>
          <strong>还没有归档任何会话</strong>
          点「立即同步」把本机的会话收进来。
        </div>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>会话</th>
            <th className="n">事件</th>
            <th className="n">大小</th>
            <th className="n">开始于</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={`${s.harness}:${s.session}`}>
              <td>
                <Link
                  className="truncate"
                  style={{ display: 'block', maxWidth: '38ch' }}
                  title={s.title ?? s.firstText ?? s.session}
                  to={`/sessions/${encodeURIComponent(`${s.harness}:${s.session}`)}`}
                >
                  {s.title ?? s.firstText ?? s.session}
                </Link>
                <span className="sub mono truncate" title={s.cwd}>
                  {s.harness} · {s.session.slice(0, 8)}
                  {s.cwd ? ` · ${s.cwd.split('/').slice(-2).join('/')}` : ''}
                </span>
              </td>
              <td className="n num">{n(s.events)}</td>
              <td className="n num">{bytes(s.bytes)}</td>
              <td className="n num">{dateTime(s.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type EventPage, type SessionDetail as Detail } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { bytes, dateTime, eventKind, harnessName, n } from '../lib/format.ts';

const PAGE = 200;

export default function SessionDetail() {
  const { key = '' } = useParams();
  const detail = useAsync<Detail>(() => api.session(key), [key]);
  const [events, setEvents] = useState<EventPage['events']>([]);
  const [loaded, setLoaded] = useState(0);
  const [busy, setBusy] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  async function loadMore() {
    if (busy) return;
    const total = detail.data?.eventTotal ?? 0;
    if (total > 0 && loaded >= total) return;
    setBusy(true);
    try {
      const page = await api.sessionEvents(key, loaded, PAGE);
      setEvents((prev) => [...prev, ...page.events]);
      setLoaded((v) => v + page.events.length);
    } finally {
      setBusy(false);
    }
  }

  // 第一页自动加载,之后滚到底再拉
  useEffect(() => {
    if (loaded === 0 && !busy) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, busy]);

  const d = detail.data;
  const title = d?.title ?? d?.firstText ?? '会话';

  return (
    <>
      <Link className="back" to="/sessions">
        ← 全部会话
      </Link>
      <div className="detail-head">
        <h1>{title}</h1>
        {d ? (
          <div className="facts">
            <span>
              工具 <b>{harnessName(d.harness)}</b>
            </span>
            {d.model ? (
              <span>
                模型 <b className="mono">{d.model}</b>
              </span>
            ) : null}
            {d.cwd ? (
              <span>
                目录 <b className="mono">{d.cwd}</b>
              </span>
            ) : null}
            <span>
              事件 <b className="num">{n(d.eventTotal)}</b>
            </span>
            <span>
              设备 <b className="num">{d.sources.length}</b>
            </span>
            <span>
              开始于 <b className="num">{dateTime(d.startedAt)}</b>
            </span>
            <span className="mono" title={d.path}>
              {d.path}
            </span>
          </div>
        ) : null}
      </div>

      {detail.error ? (
        <div className="empty">
          <div>
            <strong>读不到这个会话</strong>
            {detail.error}
          </div>
        </div>
      ) : detail.loading ? (
        <div className="skeleton" style={{ height: 420 }} />
      ) : (
        <>
          <div className="stream">
            {events.map((e, i) => (
              <EventRow key={`${e.seq}-${i}`} event={e} />
            ))}
            {events.length === 0 && !busy ? (
              <div className="empty" style={{ border: 0, borderRadius: 0 }}>
                <div>这个会话没有事件</div>
              </div>
            ) : null}
          </div>
          <div ref={sentinel} style={{ height: 1 }} />
          <div style={{ display: 'grid', placeItems: 'center', padding: '16px 0' }}>
            {loaded < (d?.eventTotal ?? 0) ? (
              <span className="stamp num">
                {busy ? '读取中…' : `已读 ${n(loaded)} / ${n(d?.eventTotal ?? 0)} 条`}
              </span>
            ) : (
              <span className="stamp num">共 {n(d?.eventTotal ?? 0)} 条事件</span>
            )}
          </div>
        </>
      )}
    </>
  );
}

function EventRow({ event }: { event: EventPage['events'][number] }) {
  const { label, cls } = eventKind(event.kind, event.role);
  const truncated = event.__truncated;
  return (
    <div className={`event ${cls}`}>
      <div className="seq">{event.seq}</div>
      <div className="kind">{label}</div>
      <div className="body">
        <EventBody event={event} />
        {truncated ? (
          <div className="trunc">
            已截断:{Object.entries(truncated).map(([k, v]) => `${k} 原 ${n(v)} 字节`).join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EventBody({ event }: { event: EventPage['events'][number] }) {
  if (event.kind === 'tool_call') {
    const name = event.tool?.name ?? '工具';
    const input = event.tool?.input;
    return (
      <>
        <span style={{ color: 'var(--text)' }}>{name}</span>
        {input !== undefined ? (
          <span>{' ' + (typeof input === 'string' ? input : JSON.stringify(input))}</span>
        ) : null}
      </>
    );
  }
  if (event.kind === 'tool_result') {
    const out = event.result?.output;
    const text = typeof out === 'string' ? out : out === undefined ? '' : JSON.stringify(out);
    const status = event.result?.status === 'error' ? ' · 失败' : '';
    return (
      <>
        {status ? <span style={{ color: 'var(--negative)' }}>{status.trim()}</span> : null}
        {text}
      </>
    );
  }
  if (event.kind === 'session') {
    return <span style={{ color: 'var(--muted)' }}>{event.text ?? event.model?.id ?? '会话头'}</span>;
  }
  return <>{event.text ?? ''}</>;
}

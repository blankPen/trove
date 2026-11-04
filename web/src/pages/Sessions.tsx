import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TitleRow } from '../components/Shell.tsx';
import { api, type SessionList } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { bytes, dateTime, harnessName, n } from '../lib/format.ts';

const HARNESSES = ['', 'claude-code', 'codex', 'opencode', 'doubao'];
const PAGE = 100;

export default function Sessions() {
  const [harness, setHarness] = useState('');
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [searching, setSearching] = useState(false);

  const list = useAsync<SessionList>(
    () => api.sessions({ harness: harness || undefined, q: query || undefined, limit }),
    [harness, query, limit],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLimit(PAGE);
    setSearching(Boolean(term.trim()));
    setQuery(term.trim());
  }

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <>
      <TitleRow
        title="会话"
        sub={
          list.loading ? (
            '检索中…'
          ) : (
            <>
              {n(total)} 次会话
              {query ? ' · 正文命中' : ''}
            </>
          )
        }
      />

      <form className="filters" onSubmit={submit}>
        <div className="segmented" role="group" aria-label="按工具筛选">
          {HARNESSES.map((h) => (
            <button
              key={h || 'all'}
              type="button"
              aria-pressed={harness === h}
              onClick={() => {
                setHarness(h);
                setLimit(PAGE);
              }}
            >
              {h ? harnessName(h) : '全部'}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ width: 300 }}
          placeholder="搜正文、标题、目录、模型"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="搜索会话"
        />
        <button className="btn" type="submit" disabled={searching && list.loading}>
          {searching && list.loading ? '深搜中…' : '搜索'}
        </button>
        {query ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setTerm('');
              setQuery('');
              setLimit(PAGE);
              setSearching(false);
            }}
          >
            清除
          </button>
        ) : null}
        <div className="spacer" />
        <span className="stamp num">
          {items.length ? `1-${items.length}` : '0'} / {n(total)}
        </span>
      </form>

      {list.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {list.error}
          </div>
        </div>
      ) : list.loading ? (
        <div className="skeleton" style={{ height: 420 }} />
      ) : items.length === 0 ? (
        <div className="empty">
          <div>
            <strong>{query ? '没有命中的会话' : '还没有归档任何会话'}</strong>
            {query ? '换个词再试,深搜会扫全部会话正文。' : '先跑一次 trove sync 把本机会话收进来。'}
          </div>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>会话</th>
                  <th>工具</th>
                  <th>目录</th>
                  <th>模型</th>
                  <th className="n">事件</th>
                  <th className="n">大小</th>
                  <th className="n">开始于</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={`${s.harness}:${s.session}`}>
                    <td>
                      <Link to={`/sessions/${encodeURIComponent(`${s.harness}:${s.session}`)}`}>
                        {s.title ?? s.firstText ?? s.session}
                      </Link>
                      <span className="sub mono">{s.session.slice(0, 12)}</span>
                    </td>
                    <td className="stamp">{harnessName(s.harness)}</td>
                    <td className="stamp truncate" title={s.cwd}>
                      {s.cwd ?? '—'}
                    </td>
                    <td className="stamp">{s.model ?? '—'}</td>
                    <td className="n num">{n(s.events)}</td>
                    <td className="n num">{bytes(s.bytes)}</td>
                    <td className="n num">{dateTime(s.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length < total ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: '18px 0' }}>
              <button className="btn" onClick={() => setLimit((v) => v + PAGE)}>
                加载更多
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

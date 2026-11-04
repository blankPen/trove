import { useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { TitleRow } from '../components/Shell.tsx';
import { api, type LessonCategory } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { dateTime, n } from '../lib/format.ts';

export default function Lessons() {
  const lessons = useAsync<LessonCategory[]>(() => api.lessons(), []);
  const [selected, setSelected] = useState<string>();
  const [term, setTerm] = useState('');

  const cats = lessons.data ?? [];
  const total = cats.reduce((sum, c) => sum + c.count, 0);
  const needle = term.trim().toLowerCase();

  // 搜索时跨类目汇总,平时按类目分组
  const filtered = useMemo(() => {
    if (!needle) return cats;
    return cats
      .map((c) => ({
        ...c,
        items: c.items.filter(
          (i) =>
            i.title.toLowerCase().includes(needle) ||
            i.preview.toLowerCase().includes(needle) ||
            i.type.toLowerCase().includes(needle) ||
            i.tags.some((t) => t.toLowerCase().includes(needle)),
        ),
      }))
      .filter((c) => c.items.length > 0);
  }, [cats, needle]);

  const flat = filtered.flatMap((c) => c.items);
  const current = selected ?? flat[0]?.path;
  const currentItem = flat.find((i) => i.path === current);
  const file = useAsync(() => (current ? api.lessonFile(current) : Promise.resolve(null)), [current]);

  return (
    <>
      <TitleRow
        title="沉淀"
        sub={
          lessons.loading ? (
            '读取中…'
          ) : (
            <>
              {n(total)} 条记忆 · 五类分层 · 正文可全文搜索
            </>
          )
        }
      />

      <div className="filters">
        <input
          className="input"
          style={{ width: 300 }}
          placeholder="搜标题、正文、标签"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="搜索记忆"
        />
        <div className="spacer" />
        <span className="stamp num">{n(flat.length)} 条</span>
      </div>

      {lessons.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {lessons.error}
          </div>
        </div>
      ) : lessons.loading ? (
        <div className="skeleton" style={{ height: 420 }} />
      ) : flat.length === 0 ? (
        <div className="empty">
          <div>
            <strong>{needle ? '没有匹配的记忆' : '还没有沉淀任何记忆'}</strong>
            {needle ? '换个词再试。' : '跑一次 trove learn 把会话里的经验提炼出来。'}
          </div>
        </div>
      ) : (
        <div className="split split-cols">
          <div style={{ display: 'grid', gap: 18 }}>
            {filtered.map((c) => (
              <div key={c.category}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 6,
                    color: 'var(--muted)',
                    fontSize: 'var(--fs-small)',
                  }}
                >
                  <span>{c.label}</span>
                  <span className="num">{n(c.count)}</span>
                </div>
                <ul className="rows">
                  {c.items.map((i) => (
                    <li key={i.path}>
                      <button
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          border: 0,
                          borderRadius: 'var(--radius-control)',
                          background: i.path === current ? 'var(--active)' : 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelected(i.path)}
                        aria-current={i.path === current}
                      >
                        <span
                          className="truncate"
                          style={{ display: 'block', fontWeight: i.path === current ? 500 : 400 }}
                          title={i.title}
                        >
                          {i.title}
                        </span>
                        <span
                          className="mono"
                          style={{ display: 'block', color: 'var(--faint)', fontSize: 'var(--fs-small)' }}
                        >
                          {i.type}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <article className="panel">
            {file.loading ? (
              <div className="skeleton" style={{ height: 320 }} />
            ) : file.data ? (
              <>
                <header>
                  <h2 style={{ fontSize: 'var(--fs-section)', fontWeight: 600 }}>
                    {currentItem?.title ?? file.data.path}
                  </h2>
                  <span className="meta mono">{file.data.path}</span>
                </header>
                <Markdown text={file.data.content} />
              </>
            ) : null}
          </article>
        </div>
      )}
    </>
  );
}

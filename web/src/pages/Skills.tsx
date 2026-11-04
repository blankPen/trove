import { useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { TitleRow } from '../components/Shell.tsx';
import { api, type SkillItem } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { bytes, dateTime, n } from '../lib/format.ts';
import { highlight, langOf } from '../lib/highlight.ts';

export default function Skills() {
  const skills = useAsync<SkillItem[]>(() => api.skills(), []);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string>();
  const [openFile, setOpenFile] = useState<string>();

  const list = skills.data ?? [];
  const needle = term.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? list.filter(
            (s) =>
              s.name.toLowerCase().includes(needle) || s.source.toLowerCase().includes(needle),
          )
        : list,
    [list, needle],
  );

  const current = list.find((s) => s.name === selected) ?? filtered[0];
  const version = current?.versions.find((v) => v.hash === current.latest) ?? current?.versions[0];
  // 没点文件时先打开最新版本的头一个文件,右侧不留空
  const shown = openFile ?? version?.files[0]?.rel;
  const file = useAsync(
    () =>
      current && version && shown
        ? api.skillFile(current.name, version.hash, shown)
        : Promise.resolve(null),
    [current?.name, version?.hash, shown],
  );

  return (
    <>
      <TitleRow
        title="技能"
        sub={
          skills.loading ? (
            '读取中…'
          ) : (
            <>
              {n(list.length)} 个技能 · 内容寻址,同名按 hash 保留各版本
            </>
          )
        }
      />

      <div className="filters">
        <input
          className="input"
          style={{ width: 300 }}
          placeholder="搜技能名或来源"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="搜索技能"
        />
        <div className="spacer" />
        <span className="stamp num">{n(filtered.length)} 个</span>
      </div>

      {skills.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {skills.error}
          </div>
        </div>
      ) : skills.loading ? (
        <div className="skeleton" style={{ height: 420 }} />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div>
            <strong>{needle ? '没有匹配的技能' : '还没有汇总任何技能'}</strong>
            {needle ? '换个词再试。' : '跑一次 trove sync,技能会随会话一起归档。'}
          </div>
        </div>
      ) : (
        <div className="split split-cols">
          <ul className="rows">
            {filtered.map((s) => (
              <li key={s.name}>
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 10,
                    width: '100%',
                    padding: '9px 10px',
                    border: 0,
                    borderRadius: 'var(--radius-control)',
                    background: s.name === current?.name ? 'var(--active)' : 'transparent',
                    color: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelected(s.name);
                    setOpenFile(undefined);
                  }}
                  aria-current={s.name === current?.name}
                >
                  <span
                    className="truncate"
                    style={{ fontWeight: s.name === current?.name ? 500 : 400 }}
                  >
                    {s.name}
                  </span>
                  <span className="stamp">{s.source}</span>
                </button>
              </li>
            ))}
          </ul>

          {current && version ? (
            <section className="panel">
              <header>
                <h2>{current.name}</h2>
                <span className="meta mono">{version.hash.slice(0, 12)}</span>
              </header>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '6px 14px',
                  margin: '0 0 18px',
                }}
              >
                <dt className="stamp">来源</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{version.source}</dd>
                <dt className="stamp">版本</dt>
                <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
                  {current.version ?? '未标版本'}
                </dd>
                <dt className="stamp">设备</dt>
                <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
                  {current.devices.join('、') || '—'}
                </dd>
                <dt className="stamp">更新时间</dt>
                <dd className="num" style={{ margin: 0, textAlign: 'right' }}>
                  {dateTime(version.updatedAt)}
                </dd>
              </dl>

              <div style={{ display: 'grid', gap: 14 }}>
                <div>
                  <div className="stamp" style={{ marginBottom: 6 }}>
                    文件({version.files.length})
                  </div>
                  <ul className="rows">
                    {version.files.map((f) => (
                      <li key={f.rel} className="row" style={{ minHeight: 34, padding: '4px 0' }}>
                        <button
                          className="card-link mono"
                          style={{ fontSize: 'var(--fs-small)', fontWeight: 400 }}
                          onClick={() => setOpenFile(f.rel)}
                          aria-current={f.rel === shown}
                        >
                          {f.rel}
                        </button>
                        <span className="num stamp" style={{ marginLeft: 'auto' }}>
                          {bytes(f.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                {shown ? (
                  <div>
                    <div className="stamp" style={{ marginBottom: 6 }}>
                      {shown}
                    </div>
                    {file.loading ? (
                      <div className="skeleton" style={{ height: 200 }} />
                    ) : file.data ? (
                      shown.endsWith('.md') ? (
                        <Markdown text={file.data.content} />
                      ) : (
                        <pre
                          className="code hljs"
                          style={{ margin: 0, whiteSpace: 'pre-wrap' }}
                          dangerouslySetInnerHTML={{
                            __html: highlight(file.data.content, langOf(shown)),
                          }}
                        />
                      )
                    ) : (
                      <div className="empty">读不到这个文件</div>
                    )}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

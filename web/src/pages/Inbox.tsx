import { useState } from 'react';
import { TitleRow } from '../components/Shell.tsx';
import { api, type InboxItem, type InboxState } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { n } from '../lib/format.ts';

/** 质量五维:顺序即展示顺序,键对应 quality 字段。 */
const DIMS: Array<[keyof NonNullable<InboxItem['quality']>, string]> = [
  ['specific', '具体'],
  ['actionable', '可操作'],
  ['transferable', '可迁移'],
  ['evidence', '证据'],
  ['non_duplicate', '去重'],
];

/** 正文预览:空白压成单空格,截到 200 字。 */
function preview(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function Inbox() {
  const inbox = useAsync<InboxState>(() => api.inbox(), []);
  const [gone, setGone] = useState<Record<string, 'skip' | 'reject'>>({});
  const [accepted, setAccepted] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<Record<string, 'accept' | 'reject'>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const trust = inbox.data?.trust;
  const items = (inbox.data?.items ?? []).filter((i) => !gone[i.id]);
  const pending = items.filter((i) => !accepted[i.id]).length;

  async function accept(id: string) {
    setBusy((b) => ({ ...b, [id]: 'accept' }));
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    try {
      const r = await api.acceptInbox(id);
      // 不 reload:候选已被服务端写盘,卡片留在原位显示写入路径(刷新后自然消失)
      setAccepted((a) => ({ ...a, [id]: r.paths }));
    } catch (e) {
      setErrors((er) => ({ ...er, [id]: (e as Error).message }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  async function reject(id: string) {
    setBusy((b) => ({ ...b, [id]: 'reject' }));
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    try {
      await api.rejectInbox(id);
      setGone((g) => ({ ...g, [id]: 'reject' }));
      inbox.reload();
    } catch (e) {
      setErrors((er) => ({ ...er, [id]: (e as Error).message }));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <>
      <TitleRow
        title="Inbox"
        sub={
          inbox.loading
            ? '读取中…'
            : `待人工审核的候选经验 · trust L${trust?.level ?? 0} · 待审 ${n(pending)} · 已接受 ${n(trust?.accepted ?? 0)} · 已拒绝 ${n(trust?.rejected ?? 0)}`
        }
      />

      {inbox.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {inbox.error}
          </div>
        </div>
      ) : inbox.loading ? (
        <div className="skeleton" style={{ height: 320 }} />
      ) : items.length === 0 ? (
        <div className="empty">
          <div>
            <strong>暂无待审候选</strong>
            学习流水线在 review 模式会把新候选放进这里,接受后才会写进沉淀。
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          {items.map((i) => (
            <section className="panel" key={i.id}>
              <header>
                <h2>{i.title}</h2>
                <span className="meta mono">{i.type}</span>
              </header>

              {i.quality ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 10 }}>
                  {DIMS.map(([k, label]) => (
                    <span className="stamp num" key={k}>
                      {label} {(i.quality![k] * 100).toFixed(0)}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="sub mono" style={{ marginBottom: 10 }}>
                {i.session}
                {i.scope ? ` · ${i.scope}` : ''} · {i.createdAt}
              </div>

              {i.evidence.length > 0 ? (
                <details style={{ marginBottom: 10 }}>
                  <summary className="stamp" style={{ cursor: 'pointer' }}>
                    证据 {i.evidence.length} 条
                  </summary>
                  <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                    {i.evidence.map((e, j) => (
                      <blockquote key={j} className="stamp" style={{ margin: 0, paddingLeft: 12, borderLeft: '2px solid var(--control)' }}>
                        [{e.seq}] {e.quote}
                      </blockquote>
                    ))}
                  </div>
                </details>
              ) : null}

              <p style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap', marginBottom: 14 }}>{preview(i.content)}</p>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn primary"
                  onClick={() => void accept(i.id)}
                  disabled={busy[i.id] === 'accept' || accepted[i.id] !== undefined}
                >
                  {busy[i.id] === 'accept' ? '接受中…' : '接受'}
                </button>
                <button
                  className="btn"
                  onClick={() => void reject(i.id)}
                  disabled={busy[i.id] === 'reject' || accepted[i.id] !== undefined}
                >
                  {busy[i.id] === 'reject' ? '拒绝中…' : '拒绝'}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setGone((g) => ({ ...g, [i.id]: 'skip' }))}
                  disabled={accepted[i.id] !== undefined}
                >
                  跳过
                </button>
              </div>

              {accepted[i.id] ? (
                <div className="pill pos" style={{ marginTop: 12 }}>
                  <i className="dot" />
                  已写入 {n(accepted[i.id]!.length)} 个文件
                  {accepted[i.id]!.map((p) => (
                    <span className="mono" key={p}>
                      {p}
                    </span>
                  ))}
                </div>
              ) : null}
              {errors[i.id] ? (
                <div className="pill neg" style={{ marginTop: 12 }}>
                  {errors[i.id]}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

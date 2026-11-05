import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Panel, TitleRow } from '../components/Shell.tsx';
import { api, type MemoryHealth } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { n } from '../lib/format.ts';

const CATEGORY_LABELS: Record<string, string> = {
  preferences: '偏好',
  entities: '实体',
  experiences: '经验',
  events: '决策',
  resources: '资源',
};

export default function Health() {
  const health = useAsync<MemoryHealth>(() => api.health(), []);
  const h = health.data;

  return (
    <>
      <TitleRow
        title="健康"
        sub="记忆库体检:陈旧、归档、覆盖缺口、使用信号,以及作业与检索索引的现状。"
      />

      {health.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {health.error}
          </div>
        </div>
      ) : !h ? (
        <div className="skeleton" style={{ height: 260 }} />
      ) : (
        <>
          <Kpis h={h} />

          <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
            <Panel title="分类分布" meta="按五类" span={6}>
              <CategoryMix h={h} />
            </Panel>
            <Panel title="使用信号" meta="记忆检索与反馈" span={6}>
              <StatDl
                rows={[
                  ['检索', h.usage.retrieved],
                  ['查看', h.usage.viewed],
                  ['有用', h.usage.helpful],
                  ['有害', h.usage.harmful],
                  ['近 7 天', h.usage.last7d],
                ]}
              />
            </Panel>
          </div>

          <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
            <Panel title="作业队列" meta="学习作业状态" span={6}>
              {h.jobs ? (
                <StatDl
                  rows={[
                    ['排队', h.jobs.queued],
                    ['运行中', h.jobs.running],
                    ['重试等待', h.jobs.retry],
                    ['死信', h.jobs.dead],
                  ]}
                />
              ) : (
                <div className="empty">还没有学习作业队列</div>
              )}
            </Panel>
            <Panel title="检索索引" meta="qmd 本地混合检索" span={6}>
              {h.searchIndex ? (
                <StatDl
                  rows={[
                    ['文档', h.searchIndex.documents],
                    ['待嵌入', h.searchIndex.needsEmbedding],
                  ]}
                />
              ) : (
                <div className="empty">还没有检索索引</div>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function Kpis({ h }: { h: MemoryHealth }) {
  const cells: Array<[string, number]> = [
    ['记忆', h.total],
    ['待审', h.inboxPending],
    ['stale', h.stale],
    ['归档', h.archived],
    ['固定', h.pinned],
    ['缺证据', h.missingEvidence],
    ['未引用轨迹', h.unreferencedTrajectories],
    ['重复', h.duplicates],
    ['低质量', h.lowQuality],
  ];
  return (
    <div className="kpis">
      {cells.map(([label, value]) => (
        <div className="kpi" key={label}>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value num">{n(value)}</div>
        </div>
      ))}
    </div>
  );
}

/** 五类记忆的数量排行:细灰条,最大的一项用墨色(与总览的沉淀分布同口径)。 */
function CategoryMix({ h }: { h: MemoryHealth }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      Object.entries(h.byCategory)
        .map(([k, v]) => ({ label: CATEGORY_LABELS[k] ?? k, value: v }))
        .sort((a, b) => b.value - a.value),
    [h.byCategory],
  );

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

  if (!rows.length) return <div className="empty">还没有记忆</div>;
  return <div className="chart" ref={ref} />;
}

function StatDl({ rows }: { rows: Array<[string, string | number]> }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0 }}>
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="stamp">{label}</dt>
          <dd className="num mono" style={{ margin: 0, textAlign: 'right' }}>
            {typeof value === 'number' ? n(value) : value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

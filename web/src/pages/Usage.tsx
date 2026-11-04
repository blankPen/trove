import { Panel, TitleRow } from '../components/Shell.tsx';
import { api, type Usage } from '../api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { n, tokens } from '../lib/format.ts';

export default function Usage() {
  const usage = useAsync<Usage>(() => api.usage(), []);
  const u = usage.data;

  return (
    <>
      <TitleRow
        title="用量"
        sub="trove 自己调用 LLM 的 token 消耗(经验提取、摘要等)。归档会话里的消耗不在此统计。"
      />

      {usage.error ? (
        <div className="empty">
          <div>
            <strong>读取失败</strong>
            {usage.error}
          </div>
        </div>
      ) : !u ? (
        <div className="skeleton" style={{ height: 220 }} />
      ) : (
        <>
          <Kpis u={u} />

          {!u.hasLedger ? (
            <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
              <Panel title="让台账有数的三步" meta="还没有任何调用记录" span={12}>
                <Steps u={u} />
              </Panel>
            </div>
          ) : (
            <div className="grid top" style={{ marginTop: 'var(--gap)' }}>
              <Panel title="按任务" span={6}>
                <BucketTable buckets={u.byTask} />
              </Panel>
              <Panel title="按模型" span={6}>
                <BucketTable buckets={u.byModel} />
              </Panel>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Kpis({ u }: { u: Usage }) {
  const cells: Array<[string, string]> = [
    ['调用次数', n(u.total.calls)],
    ['输入 tokens', tokens(u.total.promptTokens)],
    ['输出 tokens', tokens(u.total.completionTokens)],
    ['合计', tokens(u.total.totalTokens)],
  ];
  return (
    <div className="kpis">
      {cells.map(([label, value]) => (
        <div className="kpi" key={label}>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value num">{value}</div>
        </div>
      ))}
    </div>
  );
}

/** 台账为空时的上手三步:顺序有意义,配好端点 → 提取一次 → 出现记录。 */
function Steps({ u }: { u: Usage }) {
  const queued = u.pendingExtraction.length;
  const fields: Array<[string, boolean]> = [
    ['baseUrl', u.llmFields.baseUrl],
    ['model', u.llmFields.model],
    ['apiKey', u.llmFields.apiKey],
  ];
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          <tr>
            <td className="n num" style={{ color: 'var(--faint)' }}>
              1
            </td>
            <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>配上 LLM 端点</td>
            <td style={{ color: 'var(--muted)' }}>
              <span className="mono">trove config set llm.baseUrl / llm.model / llm.apiKey</span>
            </td>
            <td className="n">
              <span style={{ display: 'inline-flex', gap: 6 }}>
                {fields.map(([name, ok]) => (
                  <span key={name} className={`pill${ok ? ' pos' : ''}`}>
                    <i className="dot" />
                    {name} {ok ? '已配' : '未配'}
                  </span>
                ))}
              </span>
            </td>
          </tr>
          <tr>
            <td className="n num" style={{ color: 'var(--faint)' }}>
              2
            </td>
            <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>跑一次经验提取</td>
            <td style={{ color: 'var(--muted)' }}>
              {queued ? (
                <>队列里还有 {n(queued)} 个会话没提取</>
              ) : (
                <>
                  跑 <span className="mono">trove learn -n 3</span>,或让 daemon 在后台跑
                </>
              )}
            </td>
            <td className="n">
              <span className="pill">
                <i className="dot" />
                {queued ? `${n(queued)} 个待提取` : '待办'}
              </span>
            </td>
          </tr>
          <tr>
            <td className="n num" style={{ color: 'var(--faint)' }}>
              3
            </td>
            <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>台账出现记录</td>
            <td style={{ color: 'var(--muted)' }}>每次调用都记一行,只追加</td>
            <td className="n">
              <span className="pill">
                <i className="dot" />
                待办
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function BucketTable({
  buckets,
  empty = '暂无记录',
}: {
  buckets: Record<string, Usage['total']>;
  empty?: string;
}) {
  const rows = Object.entries(buckets).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  // 空表保留框与表头,只在框里给一句话
  if (!rows.length) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>任务 / 模型</th>
              <th className="n">次数</th>
              <th className="n">合计</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={3} style={{ color: 'var(--muted)', borderBottom: 0, height: 96 }}>
                {empty}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>任务 / 模型</th>
            <th className="n">次数</th>
            <th className="n">输入</th>
            <th className="n">输出</th>
            <th className="n">合计</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, b]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td className="n num">{n(b.calls)}</td>
              <td className="n num">{tokens(b.promptTokens)}</td>
              <td className="n num">{tokens(b.completionTokens)}</td>
              <td className="n num">{tokens(b.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

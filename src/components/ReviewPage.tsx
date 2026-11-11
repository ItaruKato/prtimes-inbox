import { useMemo } from 'react';
import type { Item, RuleReport } from '../types';
import type { Triage } from '../state/useTriage';
import { EXCLUSION_RULES } from '../lib/exclusion';
import { fullDate, num } from '../lib/format';
import { NotifyBox } from './NotifyBox';

const SAMPLE = 15;
const DAY = 86400e3;

/** 週ごとに同じ見本になるよう、記事IDと週から決まる順に並べる */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : '0.0');

/** ルールの点検（週1回）：週ごとの件数の推移・除外された記事の見本・取りこぼし候補 */
export function ReviewPage({ t }: { t: Triage }) {
  const reports = t.reports; // 新しい週が先頭
  const latestComplete = reports.find((r) => r.complete);
  const current = reports.find((r) => !r.complete);
  const seed = latestComplete?.weekStart ?? '';
  const since = Date.now() - 7 * DAY;

  // 読み込み済みの記事から、直近7日でルールに当たった記事の見本
  const samples = useMemo(() => {
    const m: Record<string, Item[]> = {};
    for (const r of EXCLUSION_RULES) m[r.id] = [];
    for (const it of t.items) if (it.ts >= since) for (const id of it.rules) m[id]?.push(it);
    for (const id of Object.keys(m))
      m[id] = m[id].sort((a, b) => hash(a.id + seed) - hash(b.id + seed)).slice(0, SAMPLE);
    return m;
  }, [t.items, since, seed]);

  const flags = (id: string): string[] => {
    const out: string[] = [];
    const [w0, w1] = reports.filter((r) => r.complete);
    const s0 = w0?.rules[id];
    const s1 = w1?.rules[id];
    if (s0 && s0.restored >= 2) out.push(`先週 ${s0.restored}件を戻した（ルールの見直しが必要かも）`);
    if (s0 && s1 && s1.excluded > 0 && w0 && w1) {
      const r0 = s0.excluded / Math.max(1, w0.totalArticles);
      const r1 = s1.excluded / Math.max(1, w1.totalArticles);
      if (r0 > r1 * 2 && s0.excluded >= 20) out.push('除外の割合が前の週の2倍以上に増えた');
    }
    return out;
  };

  return (
    <section className="review" aria-label="除外ルールの点検">
      <header className="reviewhead">
        <button className="close" type="button" onClick={() => t.setPage('triage')}>‹ 振り分けに戻る</button>
        <h1>除外ルールの点検</h1>
        <p className="muted small">
          週1回の点検用です。見本を見て「読みたい」記事があれば受信箱に戻してください（そのルールを直す材料になります）。
          {t.lastReviewedAt ? ` 前回の点検：${fullDate(new Date(t.lastReviewedAt).getTime())}` : ' まだ点検していません。'}
        </p>
        <div className="reviewacts">
          <button className="btn primary" type="button" onClick={t.markReviewed}>点検済みにする</button>
          {reports[0] && <span className="muted small">集計：{fullDate(new Date(reports[0].generatedAt).getTime())}（毎週月曜の朝に更新）</span>}
        </div>
      </header>

      {EXCLUSION_RULES.map((rule) => {
        const on = !t.disabledRules.has(rule.id);
        const f = flags(rule.id);
        return (
          <article key={rule.id} className="rulecard">
            <div className="rulecardhead">
              <label className="ruleline">
                <input type="checkbox" checked={on} onChange={(e) => t.setRuleEnabled(rule.id, e.target.checked)} />
                <b>{rule.label}</b>
              </label>
              <span className="muted small">更新 {rule.updated}</span>
            </div>
            <p className="ruledesc">{rule.description}</p>
            {f.map((x) => (
              <p key={x} className="warn">{x}</p>
            ))}
            <WeekTable reports={reports} id={rule.id} />
            <h3>直近7日に除外した記事の見本（{num(samples[rule.id]?.length ?? 0)}件）</h3>
            {samples[rule.id]?.length ? (
              <ul className="samples">
                {samples[rule.id].map((it) => {
                  const st = t.statusOf(it);
                  return (
                    <li key={it.id}>
                      <div className="samplebody">
                        <a href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a>
                        <span className="muted small">{it.company} ・ {fullDate(it.ts)}</span>
                      </div>
                      {st === 'drop' ? (
                        <button className="act" type="button" onClick={() => t.setStatus(it.id, 'inbox')}>読みたい（受信箱へ）</button>
                      ) : (
                        <span className="muted small">戻し済み</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted small">直近7日に当てはまる記事はありません（表示期間を「直近7日」以上にすると見本が出ます）。</p>
            )}
          </article>
        );
      })}

      <article className="rulecard">
        <h2>取りこぼし候補</h2>
        <p className="muted small">
          理由を書いて不要にしたのに、どのルールにも当たらなかった記事です。同じ種類が10件以上たまると、毎晩の見直しで新しいルールになります。
        </p>
        <Uncovered title="今週" r={current} />
        <Uncovered title="先週" r={latestComplete} />
      </article>

      <article className="rulecard">
        <NotifyBox />
      </article>
    </section>
  );
}

function WeekTable({ reports, id }: { reports: RuleReport[]; id: string }) {
  if (!reports.length) return <p className="muted small">集計はまだありません（毎週月曜の朝に作られます）。</p>;
  return (
    <div className="tablewrap">
      <table className="weektable">
        <thead>
          <tr>
            <th>週</th>
            <th>記事</th>
            <th>除外</th>
            <th>割合</th>
            <th>戻した</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => {
            const s = r.rules[id];
            return (
              <tr key={r.weekStart}>
                <td>{r.weekStart.slice(5).replace('-', '/')}〜{r.complete ? '' : '（途中）'}</td>
                <td>{num(r.totalArticles)}</td>
                <td>{s ? num(s.excluded) : '—'}</td>
                <td>{s ? `${pct(s.excluded, r.totalArticles)}%` : '—'}</td>
                <td className={s && s.restored >= 2 ? 'bad' : ''}>{s ? num(s.restored) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Uncovered({ title, r }: { title: string; r?: RuleReport }) {
  if (!r) return null;
  const tags = Object.entries(r.reasonTagCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="uncovered">
      <h3>
        {title}（{r.weekStart.slice(5).replace('-', '/')}〜）：{num(r.uncoveredCount)}件 ・ 手動で不要 {num(r.manualDrops)}件のうち理由あり {num(r.withReason)}件
      </h3>
      {tags.length > 0 && (
        <div className="kw">
          {tags.map(([k, n]) => (
            <span key={k}>
              {k} {n}
            </span>
          ))}
        </div>
      )}
      {r.uncovered.length > 0 && (
        <ul className="samples">
          {r.uncovered.slice(0, 15).map((u, i) => (
            <li key={i}>
              <div className="samplebody">
                <span>{u.title}</span>
                <span className="muted small">
                  {u.company} ・ [{u.reasonTags.join('、')}] {u.reason}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

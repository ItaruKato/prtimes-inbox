import type { Triage } from '../state/useTriage';
import { SCORE_LABEL, VIEWS } from '../lib/tags';
import { fullDate } from '../lib/format';
import { TagPills } from './TagPills';

export function DetailPane({ t }: { t: Triage }) {
  const it = t.sel ? t.byId.get(t.sel) : undefined;
  if (!it)
    return (
      <aside className="detail" data-open="false">
        <div className="dempty">記事を選ぶと、ここに内容が表示されます</div>
      </aside>
    );
  const st = t.statusOf(it);
  const back = it.judge.score === 'mid' ? 'cand' : 'inbox';
  return (
    <aside className="detail" data-open="true" aria-label="記事の詳細">
      <div className="dhead">
        <button className="close" type="button" onClick={() => t.setSel(null)}>‹ 一覧へ</button>
        <span className="muted small">{VIEWS.find((v) => v.k === st)!.label}</span>
      </div>
      <div className="dbody">
        <div className="sub">
          <TagPills it={it} />
          {it.ticker && <span className="tick">証券コード {it.ticker}</span>}
          {it.section && <span className="tick">{it.section}</span>}
        </div>
        <h2>{it.title}</h2>
        <div className="dmeta">
          <span>{it.company || '（会社名未取得）'}</span>
          <span className="when">{fullDate(it.ts)} 配信</span>
        </div>
        <div className="dacts">
          <a className="btn primary" href={it.url} target="_blank" rel="noopener noreferrer">PR TIMESで開く ↗</a>
          {(st === 'inbox' || st === 'cand' || st === 'drop') && (
            <button className="btn keep" type="button" onClick={() => t.setStatus(it.id, 'keep')}>✓ 読む</button>
          )}
          {st === 'keep' && (
            <button className="btn keep" type="button" onClick={() => t.setStatus(it.id, 'done')}>既読にする</button>
          )}
          {st !== 'drop' ? (
            <button className="btn drop" type="button" onClick={() => t.setStatus(it.id, 'drop')}>✕ 不要</button>
          ) : (
            <button className="btn" type="button" onClick={() => t.setStatus(it.id, back)}>
              {back === 'cand' ? '候補に戻す' : '受信箱に戻す'}
            </button>
          )}
        </div>
        <div className="summary">
          <b>おすすめ度：{SCORE_LABEL[it.judge.score]}</b>
          {it.judge.reason}
          {(!it.judge.by || it.judge.by.startsWith('rule')) && '（キーワードによる仮判定）'}
        </div>
        {it.judge.summary ? (
          <div className="summary ai">
            <b>Claude による要約</b>
            <p className="sumtext">{it.judge.summary}</p>
            {it.judge.points && it.judge.points.length > 0 && (
              <dl className="points">
                {it.judge.points.map((p, i) => (
                  <div key={i}>
                    <dt>{p.label}</dt>
                    <dd>{p.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ) : (
          it.judge.score === 'high' && (
            <div className="summary muted small">要約は、おすすめ度「高」の記事に1時間以内に付きます。</div>
          )
        )}
        {it.lead ? <div className="lead">{it.lead}</div> : <div className="lead muted">本文の冒頭は未取得です。</div>}
        {it.keywords.length > 0 && (
          <div className="kw">
            {it.keywords.slice(0, 12).map((k) => <span key={k}>{k}</span>)}
          </div>
        )}
      </div>
    </aside>
  );
}

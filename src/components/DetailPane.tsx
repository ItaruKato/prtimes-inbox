import { useEffect, useState } from 'react';
import type { Article, Item } from '../types';
import type { Triage } from '../state/useTriage';
import { SCORE_LABEL, VIEWS } from '../lib/tags';
import { fullDate } from '../lib/format';
import { TagPills } from './TagPills';
import { AI_SCORING } from '../lib/flags';
import { ReasonBox } from './ReasonBox';
import { NotePanel } from './NotePanel';
import { CompanyFactsView } from './CompanyFactsView';

/** 一覧は目次（タイトルなど）だけなので、開いた記事の全データを読み足す */
function useFull(t: Triage, base: Item | undefined): { it: Item | undefined; loading: boolean } {
  const [full, setFull] = useState<{ id: string; a: Article | null } | null>(null);
  const load = t.loadArticle;
  useEffect(() => {
    if (!base || !load) return;
    let alive = true;
    load(base)
      .then((a) => alive && setFull({ id: base.id, a }))
      .catch(() => alive && setFull({ id: base.id, a: null }));
    return () => {
      alive = false;
    };
  }, [base?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!base || !load) return { it: base, loading: false };
  if (!full || full.id !== base.id) return { it: base, loading: true };
  if (!full.a) return { it: base, loading: false };
  const a = full.a;
  return {
    it: { ...base, lead: a.lead, keywords: a.keywords, section: a.section, ticker: a.ticker || base.ticker, judge: a.ai ?? base.judge },
    loading: false,
  };
}

export function DetailPane({ t }: { t: Triage }) {
  const base = t.sel ? t.byId.get(t.sel) : undefined;
  const { it, loading } = useFull(t, base);
  if (!it)
    return (
      <aside className="detail" data-open="false">
        <div className="dempty">記事を選ぶと、ここに内容が表示されます</div>
      </aside>
    );
  const st = t.statusOf(it);
  const back = AI_SCORING && it.judge.score === 'mid' ? 'cand' : 'inbox';
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
        <CompanyFactsView articleId={it.id} />
        <div className="dacts">
          <a className="btn primary" href={it.url} target="_blank" rel="noopener noreferrer">PR TIMESで開く ↗</a>
          {(st === 'inbox' || st === 'cand' || st === 'drop') && (
            <button className="btn keep" type="button" onClick={() => t.setStatus(it.id, 'keep')}>✓ 読む</button>
          )}
          {st === 'keep' && (
            <button className="btn keep" type="button" onClick={() => t.setStatus(it.id, 'done')}>読了にする</button>
          )}
          {st !== 'drop' ? (
            <button className="btn drop" type="button" onClick={() => t.setStatus(it.id, 'drop')}>✕ 不要</button>
          ) : (
            <button className="btn" type="button" onClick={() => t.setStatus(it.id, back)}>
              {back === 'cand' ? '候補に戻す' : '受信箱に戻す'}
            </button>
          )}
        </div>
        {st === 'drop' && <ReasonBox t={t} it={it} />}
        {(st === 'keep' || st === 'done') && <NotePanel it={it} status={st} />}
        {AI_SCORING && (
          <div className="summary">
            <b>おすすめ度：{SCORE_LABEL[it.judge.score]}</b>
            {it.judge.reason}
            {(!it.judge.by || it.judge.by.startsWith('rule')) && '（キーワードによる仮判定）'}
          </div>
        )}
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
          AI_SCORING &&
          it.judge.score === 'high' && (
            <div className="summary muted small">要約は、おすすめ度「高」の記事に1時間以内に付きます。</div>
          )
        )}
        {loading ? (
          <div className="lead muted">本文を読み込み中…</div>
        ) : it.lead ? (
          <div className="lead">{it.lead}</div>
        ) : (
          <div className="lead muted">本文の冒頭は未取得です。</div>
        )}
        {it.keywords.length > 0 && (
          <div className="kw">
            {it.keywords.slice(0, 12).map((k) => <span key={k}>{k}</span>)}
          </div>
        )}
      </div>
    </aside>
  );
}

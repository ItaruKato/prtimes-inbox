import { useEffect, useRef, useState } from 'react';
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

/** スマホで記事の詳細を横にスワイプしたら一覧に戻る（これ以上ずらしたら戻る px／素早くはじいたとき） */
const BACK_SWIPE = 80;
const BACK_FLICK = { min: 35, speed: 0.4 };

export function DetailPane({ t }: { t: Triage }) {
  const base = t.sel ? t.byId.get(t.sel) : undefined;
  const { it, loading } = useFull(t, base);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; lock: 'x' | 'y' | null; t: number; v: number } | null>(null);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(0);

  // 別の記事に変わったら先頭から見せる
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
    setDx(0);
    setLeaving(0);
  }, [t.sel]);

  const close = (dir: number) => {
    setLeaving(dir);
    setTimeout(() => t.setSel(null), 160);
  };
  // 指での横スワイプ（右・左どちらでも）。メモの入力欄の中から始めたときは使わない
  const onTouchStart = (e: React.TouchEvent) => {
    const el = ref.current;
    if (!el || e.touches.length !== 1 || getComputedStyle(el).position !== 'fixed') return;
    if ((e.target as HTMLElement).closest('textarea, input, select, [contenteditable]')) return;
    const p = e.touches[0];
    drag.current = { x: p.clientX, y: p.clientY, dx: 0, lock: null, t: performance.now(), v: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    const p = e.touches[0];
    if (!d || !p) return;
    const mx = p.clientX - d.x;
    const my = p.clientY - d.y;
    if (d.lock === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) d.lock = Math.abs(mx) > Math.abs(my) * 1.3 ? 'x' : 'y';
    if (d.lock !== 'x') return;
    const now = performance.now();
    d.v = 0.6 * ((mx - d.dx) / Math.max(1, now - d.t)) + 0.4 * d.v;
    d.t = now;
    d.dx = mx;
    setDx(mx);
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.lock !== 'x') return;
    const flick = Math.abs(d.dx) >= BACK_FLICK.min && Math.abs(d.v) >= BACK_FLICK.speed && Math.sign(d.v) === Math.sign(d.dx);
    if (Math.abs(d.dx) >= BACK_SWIPE || flick) close(Math.sign(d.dx));
    else setDx(0);
  };

  if (!it)
    return (
      <aside className="detail" data-open="false">
        <div className="dempty">記事を選ぶと、ここに内容が表示されます</div>
      </aside>
    );
  const st = t.statusOf(it);
  const back = AI_SCORING && it.judge.score === 'mid' ? 'cand' : 'inbox';
  return (
    <aside
      ref={ref}
      className="detail"
      data-open="true"
      aria-label="記事の詳細"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        drag.current = null;
        setDx(0);
      }}
      style={
        leaving || dx
          ? {
              transform: `translateX(${leaving ? leaving * window.innerWidth : dx}px)`,
              transition: drag.current?.lock === 'x' ? 'none' : 'transform .16s ease-out',
            }
          : undefined
      }
    >
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
            <button
              className="btn keep"
              type="button"
              onClick={() => {
                // 読了にしたら、「読む」の次の記事を開く（最後なら前の記事、なければ一覧に戻る）
                const v = t.visible;
                const i = v.findIndex((x) => x.id === it.id);
                const next = i >= 0 ? v[i + 1] ?? v[i - 1] : undefined;
                t.setStatus(it.id, 'done');
                t.setSel(next && next.id !== it.id ? next.id : null);
              }}
            >
              読了にして次へ
            </button>
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, Item, Status } from '../types';
import type { TagFilter, Triage } from '../state/useTriage';
import { TAGS } from '../lib/tags';
import { REASON_PRESETS } from '../lib/exclusion';
import { fullDate, num } from '../lib/format';
import { TagPills } from './TagPills';
import { NotifyBox } from './NotifyBox';

const LS_ORDER = 'prt-judge-order';
const SWIPE = 90; // これ以上ずらしたら判定する（px）

type Dir = 'keep' | 'drop';

/** 判定：受信箱の記事を1件ずつカードで出し、読む／不要を決める（右スワイプ＝読む、左スワイプ＝不要） */
export function JudgePage({ t }: { t: Triage }) {
  const [order, setOrder] = useState<'new' | 'old'>(() => {
    try {
      return localStorage.getItem(LS_ORDER) === 'old' ? 'old' : 'new';
    } catch {
      return 'new';
    }
  });
  const [tag, setTag] = useState<TagFilter>('all');
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<{ id: string; dir: Dir; undo?: () => void }[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<Dir | 'skip' | null>(null);

  // 受信箱に残っている記事（判定するたびに先頭が次の記事になる）
  const queue = useMemo(() => {
    const list = t.items.filter(
      (it) =>
        !skipped.has(it.id) &&
        t.statusOf(it) === 'inbox' &&
        (tag === 'all' || (tag === 'other' ? it.judge.tags.length === 0 : it.judge.tags.includes(tag))),
    );
    return order === 'old' ? list.reverse() : list;
  }, [t, skipped, tag, order]);
  const cur = queue[0];
  const next = queue[1];

  // 本文の冒頭などを読む（いまの記事と次の2件は先に読んでおく）
  const [full, setFull] = useState<Record<string, Article | null>>({});
  useEffect(() => {
    const load = t.loadArticle;
    if (!load) return;
    for (const it of queue.slice(0, 3))
      if (!(it.id in full))
        load(it)
          .then((a) => setFull((m) => ({ ...m, [it.id]: a })))
          .catch(() => setFull((m) => ({ ...m, [it.id]: null })));
  }, [queue, full, t.loadArticle]);

  const commit = useCallback(
    (dir: Dir | 'skip') => {
      if (!cur) return;
      if (dir === 'skip') {
        setSkipped((s) => new Set(s).add(cur.id));
      } else {
        const undo = t.setStatus(cur.id, dir as Status, { quiet: true, reasonTags: dir === 'drop' ? reasons : undefined });
        setHistory((h) => [...h.slice(-49), { id: cur.id, dir, undo }]);
      }
      setReasons([]);
      setLeaving(null);
    },
    [cur, reasons, t],
  );

  /** カードを飛ばしてから判定する（ボタン・キーボード・スワイプ共通） */
  const decide = useCallback(
    (dir: Dir | 'skip') => {
      if (!cur || leaving) return;
      setLeaving(dir);
      setTimeout(() => commit(dir), 180);
    },
    [cur, leaving, commit],
  );

  const undoLast = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    last.undo?.();
    setHistory((h) => h.slice(0, -1));
  }, [history]);

  // キーボード（PC）：→ 読む、← 不要、↓ スキップ、Z 戻す、O PR TIMESで開く
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 'r') decide('keep');
      else if (k === 'arrowleft' || k === 'x') decide('drop');
      else if (k === 'arrowdown' || k === 's') decide('skip');
      else if (k === 'z' || k === 'backspace') undoLast();
      else if (k === 'o' && cur) window.open(cur.url, '_blank', 'noopener');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, undoLast, cur]);

  const kept = history.filter((h) => h.dir === 'keep').length;
  const dropped = history.length - kept;

  return (
    <section className="judge" aria-label="判定">
      <div className="phoneonly">
        <NotifyBox banner />
      </div>
      <header className="judgehead">
        <div className="judgestats">
          <b>判定</b>
          <span className="muted small">
            残り {num(queue.length)}件 ・ 今回 読む {num(kept)}・不要 {num(dropped)}
          </span>
        </div>
        <div className="judgeopts">
          <select
            id="judge-order"
            className="rangesel"
            aria-label="並び順"
            value={order}
            onChange={(e) => {
              const v = e.target.value === 'old' ? 'old' : 'new';
              setOrder(v);
              try {
                localStorage.setItem(LS_ORDER, v);
              } catch {
                /* なし */
              }
            }}
          >
            <option value="new">新しい順</option>
            <option value="old">古い順</option>
          </select>
          <div className="chips" role="toolbar" aria-label="タグで絞り込み">
            {[{ k: 'all' as TagFilter, label: 'すべて' }, ...TAGS].map((c) => (
              <button key={c.k} className="chip" type="button" aria-pressed={tag === c.k} onClick={() => setTag(c.k)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="deck">
        {!cur && (
          <div className="empty">
            <b>{t.loading ? '読み込み中…' : 'すべて判定しました'}</b>
            {!t.loading && (skipped.size ? `スキップした ${num(skipped.size)}件は、開き直すと出てきます。` : '新着は30分ごとに届きます。')}
          </div>
        )}
        {next && <Card key={next.id} it={next} full={full[next.id]} behind />}
        {cur && (
          <Card
            key={cur.id}
            it={cur}
            full={full[cur.id]}
            leaving={leaving}
            onSwipe={(d) => decide(d)}
          />
        )}
      </div>

      {cur && (
        <div className="reasonchips judgereasons" role="group" aria-label="不要の理由（任意）">
          {REASON_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              aria-pressed={reasons.includes(p)}
              onClick={() => setReasons((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p]))}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="judgebar">
        <button className="jbtn undo" type="button" onClick={undoLast} disabled={!history.length} aria-label="ひとつ戻す">
          ↩ 戻す
        </button>
        <button className="jbtn drop" type="button" onClick={() => decide('drop')} disabled={!cur}>
          ✕ 不要
        </button>
        <button className="jbtn skip" type="button" onClick={() => decide('skip')} disabled={!cur}>
          スキップ
        </button>
        <button className="jbtn keep" type="button" onClick={() => decide('keep')} disabled={!cur}>
          ✓ 読む
        </button>
      </div>
      <p className="judgehint muted small">
        右にスワイプで「読む」、左にスワイプで「不要」。PCは → / ← キー（↓ スキップ、Z 戻す、O 開く）。理由を選んでから「不要」にすると理由も記録します。
      </p>
    </section>
  );
}

function Card({
  it,
  full,
  behind,
  leaving,
  onSwipe,
}: {
  it: Item;
  full: Article | null | undefined;
  behind?: boolean;
  leaving?: Dir | 'skip' | null;
  onSwipe?: (d: Dir) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; id: number; lock: 'x' | 'y' | null } | null>(null);
  const [dx, setDx] = useState(0);

  // 指（iPhone）はタッチイベント、マウス（PC）はポインターイベントで動かす
  // （タッチでポインターイベントを使うと、ブラウザがスクロールと判断して途中で取り消すことがある）
  const start = (x: number, y: number, id: number, target: EventTarget | null) => {
    if (behind || (target as HTMLElement | null)?.closest('a, button')) return false;
    drag.current = { x, y, dx: 0, id, lock: null };
    return true;
  };
  const move = (x: number, y: number) => {
    const d = drag.current;
    if (!d) return false;
    const mx = x - d.x;
    const my = y - d.y;
    if (d.lock === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) d.lock = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (d.lock !== 'x') return false;
    d.dx = mx;
    setDx(mx);
    return true;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.lock !== 'x') return;
    if (Math.abs(d.dx) >= SWIPE) onSwipe?.(d.dx > 0 ? 'keep' : 'drop');
    else setDx(0);
  };
  const cancel = () => {
    drag.current = null;
    setDx(0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (start(e.clientX, e.clientY, e.pointerId, e.target)) ref.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && drag.current?.id === e.pointerId) move(e.clientX, e.clientY);
  };
  const onUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') end();
  };
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (e.touches.length === 1) start(t.clientX, t.clientY, -1, e.target);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) move(t.clientX, t.clientY);
  };

  const off = leaving === 'keep' ? 1 : leaving === 'drop' ? -1 : 0;
  const x = leaving === 'skip' ? 0 : off ? off * 700 : dx;
  const style: React.CSSProperties = behind
    ? {}
    : {
        transform: `translateX(${x}px) rotate(${x / 22}deg)${leaving === 'skip' ? ' translateY(40px) scale(.96)' : ''}`,
        opacity: leaving === 'skip' ? 0 : 1,
        transition: drag.current?.lock === 'x' ? 'none' : 'transform .18s ease-out, opacity .18s ease-out',
      };
  const a = full ?? null;
  const lead = a?.lead || it.lead;
  const summary = a?.ai?.summary;

  return (
    <div
      ref={ref}
      className={behind ? 'card behind' : 'card'}
      style={style}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={(e) => e.pointerType === 'mouse' && cancel()}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={end}
      onTouchCancel={cancel}
      aria-hidden={behind || undefined}
    >
      {!behind && (
        <>
          <span className="stamp keep" style={{ opacity: Math.max(0, Math.min(1, x / SWIPE)) }}>読む</span>
          <span className="stamp drop" style={{ opacity: Math.max(0, Math.min(1, -x / SWIPE)) }}>不要</span>
        </>
      )}
      <div className="cardmeta">
        <TagPills it={it} />
        {it.ticker && <span className="tick">{it.ticker}</span>}
        <span className="muted small">{fullDate(it.ts)}</span>
      </div>
      <h2 className="cardtitle">{it.title}</h2>
      <div className="cardcompany">{it.company}</div>
      {summary && <p className="cardsummary">{summary}</p>}
      <div className="cardlead">{full === undefined ? '本文を読み込み中…' : lead || '本文の冒頭はありません。'}</div>
      <a className="btn cardopen" href={it.url} target="_blank" rel="noopener noreferrer">
        PR TIMESで開く ↗
      </a>
    </div>
  );
}

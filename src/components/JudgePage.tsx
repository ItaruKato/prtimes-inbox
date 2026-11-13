import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, Item, Status } from '../types';
import type { TagFilter, Triage } from '../state/useTriage';
import { TAGS } from '../lib/tags';
import { KEEP_PRESETS, REASON_PRESETS } from '../lib/exclusion';
import { fullDate, num } from '../lib/format';
import { TagPills } from './TagPills';
import { NotifyBox } from './NotifyBox';
import { RANGES, type RangeKey } from '../lib/range';
import { relatedItems } from '../lib/sameEvent';
import { CompanyFactsView } from './CompanyFactsView';
import { groupMarks, highlight, leaning, markChars, runsOf, type LearnModel } from '../lib/learn';

const LS_ORDER = 'prt-judge-order';
const SWIPE = 70; // これ以上ずらしたら判定する（px）
/** 素早くはじいたときは、短い距離でも判定する（距離 px・速さ px/ミリ秒） */
const FLICK_MIN = 30;
const FLICK_SPEED = 0.35;

export type Dir = 'keep' | 'drop';

/** 判定：受信箱の記事を1件ずつカードで出し、読む／不要を決める（右スワイプ＝読む、左スワイプ＝不要） */
export function JudgePage({ t, range, onRange }: { t: Triage; range?: RangeKey; onRange?: (k: RangeKey) => void }) {
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
  /** 判断の決め手としてタップした言葉と、ひとことの根拠 */
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const togglePick = useCallback((w: string) => setPicked((p) => (p.includes(w) ? p.filter((x) => x !== w) : [...p, w].slice(-10))), []);
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

  // 同じ発表とみられる別の記事（受信箱の中から）。まとめて判定する
  const { items: allItems, statusOf } = t;
  const inboxAll = useMemo(() => allItems.filter((it) => statusOf(it) === 'inbox'), [allItems, statusOf]);
  const related = useMemo(() => (cur ? relatedItems(cur, inboxAll) : []), [cur, inboxAll]);
  const [groupOff, setGroupOff] = useState<string | null>(null);
  const grouped = related.length > 0 && groupOff !== cur?.id;

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
      const others = grouped ? related : [];
      if (dir === 'skip') {
        setSkipped((s) => {
          const n = new Set(s).add(cur.id);
          for (const o of others) n.add(o.id);
          return n;
        });
      } else {
        // 根拠：理由のボタンは判定の向きに合うものだけ、決め手の言葉とひとことはそのまま
        const tags = reasons.filter((r) => (dir === 'drop' ? (REASON_PRESETS as readonly string[]) : (KEEP_PRESETS as readonly string[])).includes(r));
        const undos = [t.setStatus(cur.id, dir as Status, { quiet: true, reasonTags: tags, reason: note, terms: picked })];
        // 同じ発表の別の記事は「不要（同じ発表）」にする（読むにしたときも、読むのは1件で足りるため）
        for (const o of others) undos.push(t.setStatus(o.id, 'drop', { quiet: true, how: 'dup' }));
        const undo = () => undos.forEach((u) => u?.());
        setHistory((h) => [...h.slice(-49), { id: cur.id, dir, undo }]);
      }
      setReasons([]);
      setPicked([]);
      setNote('');
      setNoteOpen(false);
      setLeaving(null);
    },
    [cur, reasons, note, picked, t, grouped, related],
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
          {range && onRange && (
            <select id="judge-range" className="rangesel" aria-label="対象の期間" value={range} onChange={(e) => onRange(e.target.value as RangeKey)}>
              {RANGES.map((r) => (
                <option key={r.k} value={r.k}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
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
        {next && <Card key={next.id} it={next} full={full[next.id]} behind model={t.learned} />}
        {cur && (
          <Card
            key={cur.id}
            model={t.learned}
            picked={picked}
            onPick={togglePick}
            it={cur}
            full={full[cur.id]}
            leaving={leaving}
            onSwipe={(d) => decide(d)}
          />
        )}
      </div>

      {cur && related.length > 0 && (
        <div className={grouped ? 'samebox' : 'samebox off'} aria-label="同じ発表とみられる記事">
          <label className="samehead">
            <input type="checkbox" checked={grouped} onChange={(e) => setGroupOff(e.target.checked ? null : cur.id)} />
            同じ発表 {related.length}件もまとめて判定
          </label>
          <details>
            <summary>記事を見る（まとめた記事は「不要」に）</summary>
            <ul>
              {related.map((r) => (
                <li key={r.id}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title}
                  </a>
                  <span className="muted">｜{r.company}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {cur && (
        <div className="basis" aria-label="判断の根拠（任意）">
          {picked.length > 0 && (
            <div className="basispicked">
              <span className="basislabel">決め手</span>
              {picked.map((w) => (
                <button key={w} type="button" className="chip on" onClick={() => togglePick(w)} aria-label={`${w} を外す`}>
                  {w} ×
                </button>
              ))}
            </div>
          )}
          <div className="reasonchips judgereasons basisrow" role="group" aria-label="理由（任意）">
            <button
              type="button"
              className="chip note"
              aria-pressed={noteOpen || !!note}
              onClick={() => {
                setNoteOpen((o) => !o);
                setTimeout(() => noteRef.current?.focus(), 0);
              }}
            >
              ✎ ひとこと
            </button>
            <span className="basislabel keep">読む理由</span>
            {KEEP_PRESETS.map((p) => (
              <button key={p} type="button" className="chip" aria-pressed={reasons.includes(p)} onClick={() => setReasons((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p]))}>
                {p}
              </button>
            ))}
            <span className="basislabel drop">不要理由</span>
            {REASON_PRESETS.map((p) => (
              <button key={p} type="button" className="chip" aria-pressed={reasons.includes(p)} onClick={() => setReasons((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p]))}>
                {p}
              </button>
            ))}
          </div>
          {/* PC は常に表示。スマホは「ひとこと」を押したときだけ出す（CSS で切り替え） */}
          {(
            <input
              ref={noteRef}
              className={noteOpen ? 'basisnote open' : 'basisnote'}
              value={note}
              enterKeyHint="done"
              placeholder="判断の根拠をひとこと（例：物流の提案先になりそう）"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.currentTarget as HTMLInputElement).blur()}
            />
          )}
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
        右にスワイプで「読む」、左にスワイプで「不要」（軽くはじくだけでも判定します）。タイトルや本文の言葉をタップすると「決め手」として覚えます。太字は金額・ラウンド・上場などの重要語、緑はあなたが読む記事によく出る言葉、灰色は不要にする記事によく出る言葉です。PCは → / ← キー（↓ スキップ、Z 戻す、O 開く）。理由を選んでから「不要」にすると理由も記録します。
      </p>
    </section>
  );
}

/** 1件ずつのカード（判定・読む で共通）。右スワイプ＝keep、左スワイプ＝drop */
export function Card({
  it,
  full,
  behind,
  leaving,
  onSwipe,
  stamps = { keep: '読む', drop: '不要' },
  extra,
  model = null,
  picked,
  onPick,
}: {
  it: Item;
  full: Article | null | undefined;
  behind?: boolean;
  leaving?: Dir | 'skip' | null;
  onSwipe?: (d: Dir) => void;
  /** スワイプ中に出す文字 */
  stamps?: { keep: string; drop: string };
  /** 本文の冒頭の前に出すもの（読む画面の AI の要点など） */
  extra?: React.ReactNode;
  /** これまでの判定から学んだ言葉（強調に使う） */
  model?: LearnModel | null;
  /** 判断の決め手として選んだ言葉（タップで選ぶ・外す） */
  picked?: string[];
  onPick?: (w: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; id: number; lock: 'x' | 'y' | null; t: number; v: number } | null>(null);
  const [dx, setDx] = useState(0);

  // 指（iPhone）はタッチイベント、マウス（PC）はポインターイベントで動かす
  // （タッチでポインターイベントを使うと、ブラウザがスクロールと判断して途中で取り消すことがある）
  const start = (x: number, y: number, id: number, target: EventTarget | null) => {
    if (behind || (target as HTMLElement | null)?.closest('a, button')) return false;
    drag.current = { x, y, dx: 0, id, lock: null, t: performance.now(), v: 0 };
    return true;
  };
  const move = (x: number, y: number) => {
    const d = drag.current;
    if (!d) return false;
    const mx = x - d.x;
    const my = y - d.y;
    if (d.lock === null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) d.lock = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (d.lock !== 'x') return false;
    // 直近の動きの速さ（はじいたかどうかの判定に使う）
    const now = performance.now();
    const dt = Math.max(1, now - d.t);
    d.v = 0.6 * ((mx - d.dx) / dt) + 0.4 * d.v;
    d.t = now;
    d.dx = mx;
    setDx(mx);
    return true;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.lock !== 'x') return;
    const flick = Math.abs(d.dx) >= FLICK_MIN && Math.abs(d.v) >= FLICK_SPEED && Math.sign(d.v) === Math.sign(d.dx);
    if (Math.abs(d.dx) >= SWIPE || flick) onSwipe?.(d.dx > 0 ? 'keep' : 'drop');
    else setDx(0);
  };
  const cancel = () => {
    drag.current = null;
    setDx(0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    start(e.clientX, e.clientY, e.pointerId, e.target);
  };
  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || drag.current?.id !== e.pointerId) return;
    // 横に動かし始めてからつかむ（つかんだままだと、言葉のクリックがカードに取られるため）
    if (move(e.clientX, e.clientY) && !ref.current?.hasPointerCapture(e.pointerId)) ref.current?.setPointerCapture(e.pointerId);
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
          <span className="stamp keep" style={{ opacity: Math.max(0, Math.min(1, x / SWIPE)) }}>{stamps.keep}</span>
          <span className="stamp drop" style={{ opacity: Math.max(0, Math.min(1, -x / SWIPE)) }}>{stamps.drop}</span>
        </>
      )}
      <div className="cardmeta">
        <TagPills it={it} />
        {it.ticker && <span className="tick">{it.ticker}</span>}
        <span className="muted small">{fullDate(it.ts)}</span>
      </div>
      <h2 className="cardtitle">
        <Marked text={it.title} model={model} picked={behind ? undefined : picked} onPick={behind ? undefined : onPick} />
      </h2>
      <div className="cardcompany">
        {it.company}
        {!behind && <CompanyHistory company={it.company} title={it.title} model={model} />}
      </div>
      {!behind && <CompanyFactsView articleId={it.id} compact />}
      {!behind && extra}
      {summary && !extra && <p className="cardsummary">{summary}</p>}
      <div className="cardlead">
        {full === undefined ? (
          '本文を読み込み中…'
        ) : lead ? (
          <Marked text={lead} model={behind ? null : model} picked={behind ? undefined : picked} onPick={behind ? undefined : onPick} />
        ) : (
          '本文の冒頭はありません。'
        )}
      </div>
      <a className="btn cardopen" href={it.url} target="_blank" rel="noopener noreferrer">
        PR TIMESで開く ↗
      </a>
    </div>
  );
}

/** 強調した文（太字：金額・ラウンドなどの重要語、緑：読む寄りの言葉、灰：不要寄りの言葉）。onPick があれば言葉をタップで選べる */
export function Marked({ text, model, picked, onPick }: { text: string; model: LearnModel | null; picked?: string[]; onPick?: (w: string) => void }) {
  const parts = useMemo(() => {
    if (!onPick) return highlight(text, model).map((sp) => ({ spans: [sp], pick: undefined as string | undefined }));
    const marks = markChars(text, model);
    const out: { spans: ReturnType<typeof groupMarks>; pick?: string }[] = [];
    let at = 0;
    for (const r of runsOf(text)) {
      if (r.start > at) out.push({ spans: groupMarks(text, marks, at, r.start) });
      out.push({ spans: groupMarks(text, marks, r.start, r.end), pick: r.text });
      at = r.end;
    }
    if (at < text.length) out.push({ spans: groupMarks(text, marks, at, text.length) });
    return out;
  }, [text, model, onPick]);
  const inner = (spans: ReturnType<typeof groupMarks>) =>
    spans.map((sp, i) =>
      sp.mark ? (
        <mark key={i} className={`hl-${sp.mark}`}>
          {sp.text}
        </mark>
      ) : (
        <Fragment key={i}>{sp.text}</Fragment>
      ),
    );
  return (
    <>
      {parts.map((p, i) =>
        p.pick && onPick ? (
          <span
            key={i}
            className={picked?.includes(p.pick) ? 'pick picked' : 'pick'}
            onClick={(e) => {
              e.stopPropagation();
              onPick(p.pick!);
            }}
          >
            {inner(p.spans)}
          </span>
        ) : (
          <Fragment key={i}>{inner(p.spans)}</Fragment>
        ),
      )}
    </>
  );
}

/** この会社のこれまでの判定と、過去の判定に照らした傾き */
function CompanyHistory({ company, title, model }: { company: string; title: string; model: LearnModel | null }) {
  if (!model || model.n < 10) return null;
  const c = model.companies.get(company);
  const lean = leaning(title, company, model);
  const tip = lean >= 1.5 ? '読む寄り' : lean <= -1.5 ? '不要寄り' : '';
  if (!c && !tip) return null;
  return (
    <span className="history">
      {c && `これまで 読む${c.keep}・不要${c.drop}`}
      {tip && <b className={lean > 0 ? 'lean keep' : 'lean drop'}>{tip}</b>}
    </span>
  );
}

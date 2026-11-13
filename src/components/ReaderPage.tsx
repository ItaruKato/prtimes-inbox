import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Article } from '../types';
import type { Triage } from '../state/useTriage';
import { num } from '../lib/format';
import { subscribeDraft, type Draft } from '../lib/notes';
import { Card, type Dir } from './JudgePage';

const LS_ORDER = 'prt-read-order';

/**
 * 読む：「読む」にした記事を1件ずつカードで片付ける。
 * 右スワイプ＝読了（Knowledge Base に渡る）、左スワイプ＝不要、あとで＝今回は飛ばす。
 * カードには AI の要点・営業トークの切り口・相性のよいサービスを出す。メモは詳細で書く。
 */
export function ReaderPage({ t }: { t: Triage }) {
  const [order, setOrder] = useState<'new' | 'old'>(() => {
    try {
      return localStorage.getItem(LS_ORDER) === 'old' ? 'old' : 'new';
    } catch {
      return 'new';
    }
  });
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<{ id: string; dir: Dir; undo?: () => void }[]>([]);
  const [leaving, setLeaving] = useState<Dir | 'skip' | null>(null);

  const { items, statusOf } = t;
  const queue = useMemo(() => {
    const list = items.filter((it) => !skipped.has(it.id) && statusOf(it) === 'keep');
    return order === 'old' ? list.reverse() : list;
  }, [items, statusOf, skipped, order]);
  const cur = queue[0];
  const next = queue[1];

  // 本文の冒頭（いまの記事と次の2件は先に読んでおく）
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

  // AI の下書き（いまの記事）
  const [draft, setDraft] = useState<{ id: string; d: Draft | null } | null>(null);
  useEffect(() => {
    if (!cur) return;
    return subscribeDraft(cur.id, (d) => setDraft({ id: cur.id, d }));
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = draft && cur && draft.id === cur.id ? draft.d : undefined;

  const commit = useCallback(
    (dir: Dir | 'skip') => {
      if (!cur) return;
      if (dir === 'skip') setSkipped((s) => new Set(s).add(cur.id));
      else {
        const undo = t.setStatus(cur.id, dir === 'keep' ? 'done' : 'drop', { quiet: true });
        setHistory((h) => [...h.slice(-49), { id: cur.id, dir, undo }]);
      }
      setLeaving(null);
    },
    [cur, t],
  );
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
  const openMemo = useCallback(() => {
    if (!cur) return;
    t.setView('keep');
    t.setPage('triage');
    t.setSel(cur.id);
    t.setBackTo('reader');
  }, [cur, t]);

  // キーボード（PC）：→ 読了、← 不要、↓ あとで、Z 戻す、O PR TIMESで開く、M メモ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 'e') decide('keep');
      else if (k === 'arrowleft' || k === 'x') decide('drop');
      else if (k === 'arrowdown' || k === 's') decide('skip');
      else if (k === 'z' || k === 'backspace') undoLast();
      else if (k === 'o' && cur) window.open(cur.url, '_blank', 'noopener');
      else if (k === 'm') openMemo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, undoLast, openMemo, cur]);

  const doneN = history.filter((h) => h.dir === 'keep').length;
  const dropN = history.length - doneN;

  const extra =
    d === undefined || d?.state === 'working' ? (
      <div className="readai muted small">AIの要点を読み込み中…</div>
    ) : d?.state === 'done' ? (
      <div className="readai">
        {d.summary && <p className="readsum">{d.summary}</p>}
        {d.angles && d.angles.length > 0 && (
          <div className="readblock">
            <b>営業トークの切り口</b>
            <ul>
              {d.angles.slice(0, 3).map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {d.fits && d.fits.length > 0 && (
          <div className="readfits">
            {d.fits.map((f, i) => (
              <span key={i} className="pill" title={f.reason}>
                {f.service}
              </span>
            ))}
          </div>
        )}
      </div>
    ) : null;

  return (
    <section className="judge reader" aria-label="読む（1件ずつ）">
      <header className="judgehead">
        <div className="judgestats">
          <b>読む</b>
          <span className="muted small">
            残り {num(queue.length)}件 ・ 今回 読了 {num(doneN)}・不要 {num(dropN)}
          </span>
        </div>
        <div className="judgeopts">
          <button type="button" className="chip" onClick={() => (t.setView('keep'), t.setPage('triage'))}>
            ☰ 一覧で見る
          </button>
          <select
            id="read-order"
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
        </div>
      </header>

      <div className="deck">
        {!cur && (
          <div className="empty">
            <b>{t.loading ? '読み込み中…' : '「読む」の記事はありません'}</b>
            {!t.loading && (skipped.size ? `あとでにした ${num(skipped.size)}件は、開き直すと出てきます。` : '判定で「読む」にした記事がここに来ます。')}
          </div>
        )}
        {next && <Card key={next.id} it={next} full={full[next.id]} behind model={t.learned} />}
        {cur && (
          <Card
            key={cur.id}
            model={t.learned}
            it={cur}
            full={full[cur.id]}
            leaving={leaving}
            onSwipe={(dir) => decide(dir)}
            stamps={{ keep: '読了', drop: '不要' }}
            extra={extra}
          />
        )}
      </div>

      <div className="judgebar readbar">
        <button className="jbtn undo" type="button" onClick={undoLast} disabled={!history.length} aria-label="ひとつ戻す" title="ひとつ戻す">
          ↩
        </button>
        <button className="jbtn drop" type="button" onClick={() => decide('drop')} disabled={!cur}>
          ✕ 不要
        </button>
        <button className="jbtn skip" type="button" onClick={() => decide('skip')} disabled={!cur}>
          あとで
        </button>
        <button className="jbtn memo" type="button" onClick={openMemo} disabled={!cur}>
          ✎メモ
        </button>
        <button className="jbtn keep" type="button" onClick={() => decide('keep')} disabled={!cur}>
          ✓ 読了
        </button>
      </div>
      <p className="judgehint muted small">
        右にスワイプで「読了」（Knowledge Base に渡ります）、左にスワイプで「不要」。PCは → / ← キー（↓ あとで、M メモ、Z 戻す、O 開く）。
      </p>
    </section>
  );
}

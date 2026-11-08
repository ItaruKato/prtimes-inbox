import { useEffect, useState } from 'react';
import type { TagFilter, Triage } from '../state/useTriage';
import { TAGS, VIEWS } from '../lib/tags';
import { num } from '../lib/format';

const CHIPS: { k: TagFilter; label: string }[] = [{ k: 'all', label: 'すべて' }, ...TAGS, { k: 'other', label: 'タグなし' }];

export function TopBar({ t }: { t: Triage }) {
  const v = VIEWS.find((x) => x.k === t.view)!;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [t.view, t.tag, t.q]);

  const triageView = t.view === 'inbox' || t.view === 'cand';
  const scope = t.tag === 'all' && !t.q ? (t.view === 'cand' ? '候補の' : '受信箱の') : '表示中の';

  return (
    <header className="top">
      <div className="toprow">
        <h1>{v.label}</h1>
        <span className="meta">
          {num(t.visible.length)}件{v.note ? ` ・ ${v.note}` : ''}
        </span>
        <input
          id="q"
          className="search"
          type="search"
          placeholder="タイトル・会社名で検索"
          aria-label="検索"
          value={t.q}
          onChange={(e) => t.setQ(e.target.value)}
        />
      </div>
      <div className="chips" role="toolbar" aria-label="タグで絞り込み">
        {CHIPS.map((c) => (
          <button key={c.k} className="chip" type="button" aria-pressed={t.tag === c.k} onClick={() => t.setTag(c.k)}>
            {c.label}
            <span className="n">{num(t.tagCounts[c.k] ?? 0)}</span>
          </button>
        ))}
      </div>
      {triageView && t.visible.length > 0 && (
        <div className="bulkbar">
          {confirm ? (
            <>
              <span>
                {scope}
                {num(t.visible.length)}件をすべて不要にしますか？
              </span>
              <button className="yes" type="button" onClick={() => { t.bulkDrop(t.visible.slice()); setConfirm(false); }}>
                不要にする
              </button>
              <button className="no" type="button" onClick={() => setConfirm(false)}>
                やめる
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirm(true)}>
              {scope}
              {num(t.visible.length)}件をまとめて不要
            </button>
          )}
        </div>
      )}
    </header>
  );
}

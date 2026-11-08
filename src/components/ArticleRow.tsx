import { memo, useRef } from 'react';
import type { Item, Status } from '../types';
import { hm } from '../lib/format';
import { TagPills } from './TagPills';

interface Props {
  it: Item;
  st: Status;
  selected: boolean;
  autoNote: string;
  onOpen: (id: string) => void;
  onAct: (id: string, st: Status) => void;
}

/** スワイプ：右→読む（読むの中では既読）、左→不要（不要の中では戻す） */
function swipeTarget(st: Status, dir: 1 | -1, back: Status): Status {
  if (dir > 0) return st === 'keep' ? 'done' : st === 'inbox' || st === 'cand' ? 'keep' : back;
  return st === 'drop' ? back : 'drop';
}

export const ArticleRow = memo(function ArticleRow({ it, st, selected, autoNote, onOpen, onAct }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const sw = useRef<{ x: number; y: number; dx: number; lock: 'x' | 'y' | null } | null>(null);
  const back: Status = it.judge.score === 'mid' ? 'cand' : 'inbox';

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    sw.current = { x: t.clientX, y: t.clientY, dx: 0, lock: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = sw.current;
    const el = rowRef.current;
    if (!s || !el) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (s.lock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) s.lock = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
    if (s.lock !== 'x') return;
    s.dx = dx;
    el.classList.add('dragging');
    el.style.transform = `translateX(${dx}px)`;
  };
  const onTouchEnd = () => {
    const s = sw.current;
    const el = rowRef.current;
    sw.current = null;
    if (!s || !el) return;
    el.classList.remove('dragging');
    if (s.lock === 'x' && Math.abs(s.dx) > 90) {
      const dir = s.dx > 0 ? 1 : -1;
      el.style.transform = `translateX(${dir > 0 ? '100%' : '-100%'})`;
      setTimeout(() => onAct(it.id, swipeTarget(st, dir, back)), 160);
    } else el.style.transform = '';
  };

  return (
    <div className="rowwrap">
      <div className="swipebg" aria-hidden="true">
        <span className="l">{st === 'keep' ? '既読にする' : st === 'drop' ? '戻す' : '✓ 読む'}</span>
        <span className="r">{st === 'drop' ? '戻す' : '✕ 不要'}</span>
      </div>
      <div
        ref={rowRef}
        className="row"
        data-id={it.id}
        aria-selected={selected}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="time">{hm(it.ts)}</div>
        <button className="body" type="button" onClick={() => onOpen(it.id)}>
          <span className="title">{it.title}</span>
          <span className="sub">
            <span className="company">{it.company || '（会社名未取得）'}</span>
            {it.ticker && <span className="tick">{it.ticker}</span>}
            <TagPills it={it} />
            {autoNote && <span className="auto">{autoNote}</span>}
          </span>
        </button>
        <div className="acts">
          {st === 'inbox' || st === 'cand' ? (
            <>
              <button className="act keep" type="button" onClick={() => onAct(it.id, 'keep')}>✓ 読む</button>
              <button className="act drop" type="button" onClick={() => onAct(it.id, 'drop')}>✕ 不要</button>
            </>
          ) : st === 'keep' ? (
            <>
              <button className="act keep" type="button" onClick={() => onAct(it.id, 'done')}>既読にする</button>
              <button className="act drop" type="button" onClick={() => onAct(it.id, 'drop')}>✕ 不要</button>
            </>
          ) : (
            <button className="act" type="button" onClick={() => onAct(it.id, back)}>
              {back === 'cand' ? '候補に戻す' : '受信箱に戻す'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

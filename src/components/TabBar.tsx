import type { Triage } from '../state/useTriage';
import { VIEWS } from '../lib/tags';
import { num } from '../lib/format';

/** スマホ用の下部タブ（左端が「判定」） */
export function TabBar({ t }: { t: Triage }) {
  return (
    <nav className="tabs" aria-label="振り分け">
      <button type="button" aria-current={t.page === 'judge'} onClick={() => t.setPage('judge')}>
        <b className="judgeicon" aria-hidden="true">⇆</b>
        判定
      </button>
      {VIEWS.map((v) => (
        <button
          key={v.k}
          type="button"
          aria-current={(t.page === 'triage' && t.view === v.k) || (t.page === 'reader' && v.k === 'keep')}
          onClick={() => {
            t.setPage('triage');
            t.setView(v.k);
          }}
        >
          <b>{num(t.counts[v.k])}</b>
          {v.label}
        </button>
      ))}
    </nav>
  );
}

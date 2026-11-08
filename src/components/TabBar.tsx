import type { Triage } from '../state/useTriage';
import { VIEWS } from '../lib/tags';
import { num } from '../lib/format';

/** スマホ用の下部タブ */
export function TabBar({ t }: { t: Triage }) {
  return (
    <nav className="tabs" aria-label="振り分け">
      {VIEWS.map((v) => (
        <button key={v.k} type="button" aria-current={t.view === v.k} onClick={() => t.setView(v.k)}>
          <b>{num(t.counts[v.k])}</b>
          {v.label}
        </button>
      ))}
    </nav>
  );
}

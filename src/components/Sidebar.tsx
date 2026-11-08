import type { Triage } from '../state/useTriage';
import { VIEWS } from '../lib/tags';
import { num } from '../lib/format';

export function Sidebar({ t, dataLabel }: { t: Triage; dataLabel: string }) {
  return (
    <aside className="side">
      <div className="brand">
        <b>PR TIMES 受信箱</b>
        <small>{dataLabel}</small>
      </div>
      <nav className="navgroup" aria-label="振り分け">
        <div className="navlabel">振り分け</div>
        {VIEWS.map((v) => (
          <button key={v.k} className="nav" type="button" aria-current={t.view === v.k} onClick={() => t.setView(v.k)}>
            <span>
              {v.label}
              {v.note && <small className="navnote">{v.note}</small>}
            </span>
            <span className="n">{num(t.counts[v.k])}</span>
          </button>
        ))}
      </nav>
      <div className="rulebox">
        <b>自動除外ルール</b>
        <div>・新作ゲームの案内</div>
        <div className="muted">定時株主総会などは後から追加予定</div>
      </div>
      <div className="learn">
        AIに渡す学習データ
        <br />
        手動で不要 <strong>{num(t.learning.manualDrop)}</strong> 件 ・ 候補から拾った <strong>{num(t.learning.picked)}</strong> 件
      </div>
      <div className="hint">
        <div>
          <span className="kbd">J</span>/<span className="kbd">K</span> 移動 <span className="kbd">R</span> 読む{' '}
          <span className="kbd">X</span> 不要
        </div>
        <div>
          <span className="kbd">E</span> 既読 <span className="kbd">O</span> PR TIMESで開く
        </div>
      </div>
    </aside>
  );
}

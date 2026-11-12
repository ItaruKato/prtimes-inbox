import type { Triage } from '../state/useTriage';
import { VIEWS } from '../lib/tags';
import { num } from '../lib/format';
import { USD_JPY } from '../lib/aiCost';
import { AI_SCORING } from '../lib/flags';
import { RulesPanel } from './RulesPanel';
import { NotifyBox } from './NotifyBox';

export function Sidebar({ t, dataLabel, onSignOut }: { t: Triage; dataLabel: string; onSignOut?: () => void }) {
  return (
    <aside className="side">
      <div className="brand">
        <b>PR Times Watcher</b>
        <small>{dataLabel}</small>
      </div>
      <nav className="navgroup" aria-label="振り分け">
        <div className="navlabel">振り分け</div>
        <button className="nav" type="button" aria-current={t.page === 'judge'} onClick={() => t.setPage('judge')}>
          <span>
            判定
            <small className="navnote">1件ずつ 読む／不要</small>
          </span>
          <span className="n">⇆</span>
        </button>
        {VIEWS.map((v) => (
          <button key={v.k} className="nav" type="button" aria-current={t.page === 'triage' && t.view === v.k} onClick={() => { t.setPage('triage'); t.setView(v.k); }}>
            <span>
              {v.label}
              {v.note && <small className="navnote">{v.note}</small>}
            </span>
            <span className="n">{num(t.counts[v.k])}</span>
          </button>
        ))}
      </nav>
      {t.aiStatus && (
        <div className="aibox">
          <b>{AI_SCORING ? 'Claude の判定' : 'Claude（いまは停止中）'}</b>
          <div>
            最終実行 {t.aiStatus.lastRunAt ? new Date(t.aiStatus.lastRunAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
            {t.aiStatus.judged !== undefined && `（判定 ${num(t.aiStatus.judged)}件・要約 ${num(t.aiStatus.summarized ?? 0)}件）`}
          </div>
          {((t.aiStatus.judgeErrors ?? 0) > 0 || (t.aiStatus.summaryErrors ?? 0) > 0) && (
            <div className="err">
              前回エラー：判定 {t.aiStatus.judgeErrors ?? 0}回・要約 {t.aiStatus.summaryErrors ?? 0}回（次の回に自動でやり直します）
            </div>
          )}
          <div>今月の費用 約{num(Math.round(t.aiStatus.monthUsd * USD_JPY))}円（${t.aiStatus.monthUsd.toFixed(2)}）</div>
        </div>
      )}
      <RulesPanel t={t} />
      <NotifyBox />
{AI_SCORING && (
      <div className="learn">
        AIに渡す学習データ
        <br />
        手動で不要 <strong>{num(t.learning.manualDrop)}</strong> 件 ・ 候補から拾った <strong>{num(t.learning.picked)}</strong> 件
      </div>
      )}
      <div className="hint">
        <div>
          <span className="kbd">J</span>/<span className="kbd">K</span> 移動 <span className="kbd">R</span> 読む{' '}
          <span className="kbd">X</span> 不要
        </div>
        <div>
          <span className="kbd">E</span> 読了 <span className="kbd">O</span> PR TIMESで開く
        </div>
      </div>
      {onSignOut && (
        <div className="sideactions">
          <button className="ghost" type="button" onClick={onSignOut}>ログアウト</button>
        </div>
      )}
    </aside>
  );
}

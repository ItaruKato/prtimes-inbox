import type { Triage } from '../state/useTriage';
import { EXCLUSION_RULES } from '../lib/exclusion';
import { num } from '../lib/format';

/** 自動除外ルールの一覧（オン・オフと件数）。compact はスマホの「不要」画面の上に出す版 */
export function RulesPanel({ t, compact }: { t: Triage; compact?: boolean }) {
  const body = (
    <>
      <ul className="rules">
        {EXCLUSION_RULES.map((r) => {
          const s = t.ruleStats[r.id] ?? { matched: 0, restored: 0 };
          const on = !t.disabledRules.has(r.id);
          return (
            <li key={r.id}>
              <label className="ruleline">
                <input type="checkbox" checked={on} onChange={(e) => t.setRuleEnabled(r.id, e.target.checked)} />
                <b>{r.label}</b>
                <span className="n">
                  {num(s.matched)}件{s.restored ? ` ・ 戻した ${num(s.restored)}件` : ''}
                </span>
              </label>
              <p className="ruledesc">{r.description}</p>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        不要にした理由 <strong>{num(t.reasonCount)}</strong> 件をもとに、ルールを見直していきます。
      </p>
    </>
  );
  if (!compact)
    return (
      <div className="rulebox">
        <b>自動除外ルール</b>
        {body}
      </div>
    );
  return (
    <details className="rulebox compact">
      <summary>
        <b>自動除外ルール</b>
        <span className="muted small">（{EXCLUSION_RULES.filter((r) => !t.disabledRules.has(r.id)).length}件オン）</span>
      </summary>
      {body}
    </details>
  );
}

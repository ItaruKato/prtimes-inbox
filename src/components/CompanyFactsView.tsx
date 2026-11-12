import { useEffect, useState } from 'react';
import { companyIdOf, loadCompanyFacts, type CompanyFacts } from '../lib/companyInfo';

/** 会社の情報（業種・地域・従業員・資本金・設立・上場、この1年の発表） */
export function CompanyFactsView({ articleId, compact }: { articleId: string; compact?: boolean }) {
  const cid = companyIdOf(articleId);
  const [f, setF] = useState<{ cid: string; v: CompanyFacts | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCompanyFacts(cid).then((v) => alive && setF({ cid, v }));
    return () => {
      alive = false;
    };
  }, [cid]);
  const v = f?.cid === cid ? f.v : undefined;
  if (v === undefined) return <div className={compact ? 'facts compact muted' : 'facts muted small'}>会社の情報を読み込み中…</div>;
  if (!v) return null;
  const chips = [v.industry, v.area, v.employees, v.capital && `資本金 ${v.capital}`, v.established, v.listed].filter(Boolean) as string[];
  const strong = [v.fund && `資金調達 ${v.fund}`, v.ipo && `上場 ${v.ipo}`, v.ma && `M&A ${v.ma}`].filter(Boolean).join('・');
  const year = `この1年の発表 ${v.year}件${strong ? `（${strong}）` : ''}${v.lastStrong ? ` ・ 最新の${v.lastStrong.kind} ${v.lastStrong.date}` : ''}`;
  // 判定カードでは2行に収める（あふれた分は「…」）
  if (compact)
    return (
      <div className="facts compact" aria-label="会社の情報">
        {chips.length > 0 && <div className="factline">{chips.join(' ・ ')}</div>}
        <div className="factline">{year}</div>
      </div>
    );
  return (
    <div className="facts" aria-label="会社の情報">
      {chips.length > 0 && (
        <div className="factchips">
          {chips.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
      <div className="factyear small">{year}</div>
    </div>
  );
}

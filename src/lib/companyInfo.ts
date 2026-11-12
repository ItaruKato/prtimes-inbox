import { doc, getDoc } from 'firebase/firestore';
import { firebaseEnabled, getFirebase } from '../firebase';
import { themesOf } from './mockJudge';

/** 判定カード・記事の詳細に出す会社の情報（台帳 companies と、会社ごとの記事 companyArticles から作る） */
export interface CompanyFacts {
  industry?: string;
  area?: string;
  employees?: string;
  capital?: string;
  established?: string;
  listed?: string;
  url?: string;
  /** この1年の発表の件数と、そのうち資金調達・上場・M&A の件数・最新の日付 */
  year: number;
  fund: number;
  ipo: number;
  ma: number;
  lastStrong?: { kind: string; date: string };
}

export const companyIdOf = (articleId: string) => String(parseInt(articleId.split('.')[1] ?? '', 10));

const yen = (n: number) =>
  n >= 1e8 ? `${(n / 1e8).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '')}億円` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString('ja-JP')}万円` : `${n}円`;
const areaOf = (addr?: string) => {
  const m = addr?.normalize('NFKC').match(/^(?:〒?\s*\d{3}-?\d{4}\s*)?(.+?[都道府県])(.+?[市区町村郡])?/);
  if (!m) return undefined;
  // 政令指定都市は「市」まで（例：大阪府大阪市）
  return (m[1] + (m[2] ?? '')).replace(/^(東京都|大阪府|京都府|北海道)(.*)$/, '$1$2');
};
const yearOf = (s?: string) => s?.normalize('NFKC').match(/(\d{4})/)?.[1];

type Doc = Record<string, unknown>;

export function toFacts(c: Doc | undefined, arts: Doc | undefined, now = Date.now()): CompanyFacts | null {
  if (!c && !arts) return null;
  const profile = (c?.profile ?? {}) as Record<string, string | undefined>;
  const g = (c?.gbiz ?? {}) as Record<string, unknown>;
  const insured = c?.gbizInsured as { total?: number } | undefined;
  const emp = typeof g.employees === 'number' ? `従業員 ${g.employees.toLocaleString('ja-JP')}人` : insured?.total ? `被保険者 ${insured.total.toLocaleString('ja-JP')}人` : undefined;
  const cap = typeof g.capital === 'number' && g.capital > 0 ? yen(g.capital) : profile.capital;
  const est = yearOf(String(g.established ?? '')) ?? (typeof g.foundingYear === 'number' ? String(g.foundingYear) : undefined) ?? yearOf(profile.established);
  const listed = profile.listed && profile.listed !== '未上場' ? profile.listed : profile.listed === '未上場' ? '未上場' : undefined;
  const a = (arts?.a ?? {}) as Record<string, { t?: string; p?: string }>;
  const since = now - 365 * 86400e3;
  let year = 0;
  let fund = 0;
  let ipo = 0;
  let ma = 0;
  let last: { kind: string; date: string; ts: number } | undefined;
  for (const x of Object.values(a)) {
    const ts = x.p ? new Date(x.p).getTime() : NaN;
    if (!Number.isFinite(ts) || ts < since) continue;
    year++;
    const tags = themesOf(x.t ?? '');
    const kind = tags.includes('fund') ? '資金調達' : tags.includes('ipo') ? '上場' : tags.includes('ma') ? 'M&A' : '';
    if (tags.includes('fund')) fund++;
    if (tags.includes('ipo')) ipo++;
    if (tags.includes('ma')) ma++;
    if (kind && (!last || ts > last.ts)) last = { kind, date: x.p!.slice(0, 7).replace('-', '/'), ts };
  }
  return {
    industry: profile.industry,
    area: areaOf(profile.address ?? (g.location as string | undefined)),
    employees: emp,
    capital: cap,
    established: est ? `${est}年設立` : undefined,
    listed,
    url: profile.url ?? (g.url as string | undefined),
    year,
    fund,
    ipo,
    ma,
    ...(last ? { lastStrong: { kind: last.kind, date: last.date } } : {}),
  };
}

const cache = new Map<string, Promise<CompanyFacts | null>>();

/** 会社の情報を読む（同じ会社は1回だけ） */
export function loadCompanyFacts(companyId: string): Promise<CompanyFacts | null> {
  if (!firebaseEnabled || !companyId || companyId === 'NaN') return Promise.resolve(null);
  let p = cache.get(companyId);
  if (!p) {
    const { db } = getFirebase();
    p = Promise.all([getDoc(doc(db, 'companies', companyId)), getDoc(doc(db, 'companyArticles', companyId))])
      .then(([c, a]) => toFacts(c.data(), a.data()))
      .catch(() => {
        cache.delete(companyId);
        return null;
      });
    cache.set(companyId, p);
  }
  return p;
}

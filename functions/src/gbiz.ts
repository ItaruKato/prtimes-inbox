import type { Firestore } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import { withLease } from './lease';
import type { CompanyProfile } from './company';

/**
 * gBizINFO（経済産業省）で、台帳の会社を法人番号と結びつけ、代表者・資本金・従業員数などを足す。
 * PR TIMES の会社名と「企業情報」の所在地（都道府県）で検索し、名前が一致する法人が1つに決まったときだけ結びつける。
 * 書き込み先: companies/{会社ID} の corporateNumber・gbiz・gbizAt・gbizMatch
 * 法人番号が決まった会社は、厚生年金の被保険者数（gbizInsured）と有価証券報告書の財務（gbizFinance）も読む（gbizExtraAt。180日ごとに読み直す）
 * API: https://api.info.gbiz.go.jp/hojin/v2/hojin（ヘッダー X-hojinInfo-api-token）
 */

export const GBIZ_BASE = 'https://api.info.gbiz.go.jp/hojin/v2/hojin';

const PREFS = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/** 所在地から都道府県コード（01〜47）。分からなければ null */
export function prefCode(address: string | undefined): string | null {
  if (!address) return null;
  const a = address.normalize('NFKC').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim();
  const i = PREFS.findIndex((p) => a.startsWith(p));
  return i >= 0 ? String(i + 1).padStart(2, '0') : null;
}

/** 法人格（NFKC でそろえたあとの表記） */
const LEGAL = /株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|npo法人|学校法人|医療法人|社会福祉法人|\(株\)|\(有\)/gi;

/** 比べるための名前（全角・半角、空白、記号、括弧の補足をそろえる） */
export function normName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]$/, '') // 末尾の補足（例：「LINEヤフー株式会社（LINE GAME）」）
    .replace(/[\s・･.,，、。'’"”\-‐―]/g, '')
    .toLowerCase();
}

/** 法人格（株式会社など）を除いた名前（検索語に使う） */
export function coreName(name: string): string {
  return normName(name).replace(LEGAL, '');
}

export interface GbizCandidate {
  corporate_number?: string;
  name?: string;
  location?: string;
  status?: string;
}

/**
 * 検索結果から同じ会社を1つ選ぶ。
 * 1. 名前（法人格を含む）が完全に一致する法人 → 2. 法人格を除いた名前が一致する法人。
 * 複数あるときは所在地（PR TIMES の企業情報）の先頭が一致するものに絞る。1つに決まらなければ null。
 */
export function pickCandidate(
  company: string,
  address: string | undefined,
  list: GbizCandidate[],
): { c: GbizCandidate; how: string } | { c: null; how: 'none' | 'ambiguous' } {
  const full = normName(company);
  const core = coreName(company);
  const valid = list.filter((x) => x.corporate_number && x.name);
  const byAddr = (xs: GbizCandidate[]) => {
    if (!address) return xs;
    const a = address.normalize('NFKC').replace(/\s/g, '');
    // 市区町村まで（「東京都渋谷区」など）で比べる
    const head = a.match(/^(.+?[都道府県])(.+?[市区町村郡])/)?.slice(1).join('') ?? a.slice(0, 6);
    const hit = xs.filter((x) => (x.location ?? '').normalize('NFKC').replace(/\s/g, '').startsWith(head));
    return hit.length ? hit : xs;
  };
  for (const [how, test] of [
    ['name', (x: GbizCandidate) => normName(x.name!) === full],
    ['core', (x: GbizCandidate) => coreName(x.name!) === core && core.length >= 2],
  ] as const) {
    const hits = valid.filter(test);
    if (!hits.length) continue;
    const narrowed = hits.length > 1 ? byAddr(hits) : hits;
    if (narrowed.length === 1) return { c: narrowed[0], how: hits.length > 1 ? `${how}+address` : how };
    return { c: null, how: 'ambiguous' };
  }
  return { c: null, how: 'none' };
}

/** 台帳に入れる gBizINFO の情報 */
export interface GbizInfo {
  corporateNumber: string;
  name?: string;
  kana?: string;
  location?: string;
  representative?: string;
  capital?: number;
  employees?: number;
  established?: string;
  foundingYear?: number;
  url?: string;
  summary?: string;
  businessItems?: string[];
  status?: string;
  closeDate?: string;
}

const str = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

export function toGbizInfo(h: Record<string, unknown>): GbizInfo {
  const out: GbizInfo = {
    corporateNumber: String(h.corporate_number),
    name: str(h.name),
    kana: str(h.kana),
    location: str(h.location),
    representative: str(h.representative_name, 100),
    capital: num(h.capital_stock),
    employees: num(h.employee_number),
    established: str(h.date_of_establishment, 40),
    foundingYear: num(h.founding_year),
    url: str(h.company_url),
    summary: str(h.business_summary, 400),
    businessItems: Array.isArray(h.business_items) ? (h.business_items as unknown[]).map(String).slice(0, 10) : undefined,
    status: str(h.status, 40),
    closeDate: str(h.close_date, 40),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as unknown as GbizInfo;
}

/** 金額（gBizINFO の値と単位のまま。単位が分かれば円に直した値も） */
export interface Money {
  raw: string;
  unit?: string;
  yen?: number;
}

/** 有価証券報告書（EDINET）の主要な経営指標。gBizINFO の財務情報の最新の回 */
export interface GbizFinance {
  year?: string;
  period?: string;
  sales?: Money;
  ordinaryIncome?: Money;
  netIncome?: Money;
  netAssets?: Money;
  totalAssets?: Money;
  capital?: Money;
  employees?: number;
}

/** 台帳に足す gBizINFO の追加の情報（厚生年金の加入者数と財務） */
export interface GbizExtra {
  /** 厚生年金・健康保険の被保険者数（日本年金機構の適用事業所。全喪していない事業所の合計） */
  insured?: { total: number; offices: number; updated?: string };
  finance?: GbizFinance;
}

const UNIT: [RegExp, number][] = [
  [/百万/, 1e6],
  [/千/, 1e3],
  [/^(jpy|円)$/i, 1],
];

export function toMoney(v: unknown, unit: unknown): Money | undefined {
  const raw = typeof v === 'number' ? String(v) : str(v, 40);
  if (!raw || /^(n\/a|-|－)$/i.test(raw)) return undefined;
  const u = str(unit, 20);
  const out: Money = { raw, ...(u ? { unit: u } : {}) };
  const n = Number(raw.normalize('NFKC').replace(/[,\s]/g, '').replace(/^△/, '-'));
  const mul = u ? UNIT.find(([re]) => re.test(u))?.[1] : undefined;
  if (Number.isFinite(n) && mul !== undefined) out.yen = n * mul;
  return out;
}

const periodNo = (p: unknown) => Number(String(p ?? '').normalize('NFKC').match(/\d+/)?.[0] ?? NaN);

export function toGbizExtra(corp: unknown, finance: unknown): GbizExtra {
  const out: GbizExtra = {};
  if (Array.isArray(corp)) {
    const live = (corp as Record<string, unknown>[]).filter((c) => !str(c.loss_date));
    const counts = live.map((c) => num(String(c.insured_number ?? '').normalize('NFKC').replace(/[,人\s]/g, ''))).filter((n): n is number => n !== undefined);
    if (counts.length) {
      const updated = live.map((c) => str((c['meta-data'] as Record<string, unknown> | undefined)?.last_update_date, 40)).find(Boolean);
      out.insured = { total: counts.reduce((a, b) => a + b, 0), offices: counts.length, ...(updated ? { updated } : {}) };
    }
  }
  const f = finance as Record<string, unknown> | undefined;
  const idx = Array.isArray(f?.management_index) ? (f!.management_index as Record<string, unknown>[]) : [];
  if (idx.length) {
    // 最新の回（回次の数字が一番大きいもの。数字がなければ最後）
    const latest = idx.reduce((a, b) => (periodNo(b.period) > periodNo(a.period) ? b : a), idx[idx.length - 1]);
    const m = (k: string) => toMoney(latest[`${k}_summary_of_business_results`], latest[`${k}_summary_of_business_results_unit_ref`]);
    const fin: GbizFinance = {
      year: str(f!.fiscal_year_cover_page, 60),
      period: str(latest.period, 40),
      sales: m('net_sales') ?? m('operating_revenue1') ?? m('operating_revenue2') ?? m('gross_operating_revenue') ?? m('ordinary_income'),
      ordinaryIncome: m('ordinary_income_loss'),
      netIncome: m('net_income_loss'),
      netAssets: m('net_assets'),
      totalAssets: m('total_assets'),
      capital: m('capital_stock'),
      employees: num(String(latest.number_of_employees ?? '').normalize('NFKC').replace(/[,人\s]/g, '')),
    };
    const clean = Object.fromEntries(Object.entries(fin).filter(([, v]) => v !== undefined)) as GbizFinance;
    if (Object.keys(clean).some((k) => k !== 'year' && k !== 'period')) out.finance = clean;
  }
  return out;
}

export type GbizGet = (url: string) => Promise<Record<string, unknown>>;

/** どの問い合わせか（エラーの記録に使う。会社名やトークンは入れない） */
export function gbizKind(url: string): 'search' | 'detail' | 'corporation' | 'finance' {
  if (url.includes('?')) return 'search';
  if (/\/corporation$/.test(url)) return 'corporation';
  if (/\/finance$/.test(url)) return 'finance';
  return 'detail';
}

/** gBizINFO の HTTP エラー（状態の番号と、どの問い合わせか） */
export class GbizHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: string,
  ) {
    super(`gBizINFO ${status} (${kind})`);
  }
}

/** 400（受け付けられない問い合わせ）：会社ごとに決まっていて、やり直しても同じ */
export const isBadRequest = (e: unknown) => (e instanceof GbizHttpError ? e.status === 400 : /gBizINFO 400\b/.test(String(e)));

export function gbizFetcher(token: string): GbizGet {
  return async (url) => {
    const res = await fetch(url, { headers: { 'X-hojinInfo-api-token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return {};
    if (!res.ok) throw new GbizHttpError(res.status, gbizKind(url));
    return (await res.json()) as Record<string, unknown>;
  };
}

/**
 * 法人番号が決まった会社の、厚生年金の加入者数と財務を読む。
 * 詳細（/v2/hojin/{番号}）に入っていればそれを使い、入っていなければ /corporation・/finance を読む。
 */
export async function lookupExtra(
  get: GbizGet,
  sleep: (ms: number) => Promise<void>,
  corporateNumber: string,
  detail?: Record<string, unknown>,
): Promise<GbizExtra> {
  const child = async (path: 'corporation' | 'finance') => {
    await sleep(INTERVAL_MS);
    try {
      const r = await get(`${GBIZ_BASE}/${corporateNumber}/${path}`);
      return ((r['hojin-infos'] as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    } catch (e) {
      // 400 はその会社の情報がない扱い（やり直しても同じ）。ほかのエラーは次の回にやり直す
      if (isBadRequest(e)) return {};
      throw e;
    }
  };
  const corp = detail && 'corporation-info' in detail ? detail['corporation-info'] : (await child('corporation'))['corporation-info'];
  const fin = detail && 'finance' in detail ? detail.finance : (await child('finance')).finance;
  return toGbizExtra(corp, fin);
}

/** 1社を調べる。結びつけた法人番号（なければ null）と、調べ方 */
export async function lookupCompany(
  get: GbizGet,
  sleep: (ms: number) => Promise<void>,
  company: string,
  profile: CompanyProfile | undefined,
): Promise<{ info: GbizInfo | null; how: string; extra?: GbizExtra }> {
  const core = coreName(company);
  if (core.length < 2) return { info: null, how: 'none' };
  const pref = prefCode(profile?.address);
  const term = company.normalize('NFKC').replace(/\([^)]*\)$/, '').replace(LEGAL, '').trim();
  const q = new URLSearchParams({ name: term || core, limit: '50' });
  if (pref) q.set('prefecture', pref);
  const found = await get(`${GBIZ_BASE}?${q}`);
  const list = (found['hojin-infos'] as GbizCandidate[] | undefined) ?? [];
  const pick = pickCandidate(company, profile?.address, list);
  if (!pick.c) return { info: null, how: pick.how };
  await sleep(INTERVAL_MS);
  const detail = await get(`${GBIZ_BASE}/${pick.c.corporate_number}`);
  const h = ((detail['hojin-infos'] as Record<string, unknown>[] | undefined) ?? [])[0];
  const info = toGbizInfo(h ?? (pick.c as Record<string, unknown>));
  const extra = await lookupExtra(get, sleep, info.corporateNumber, h);
  return { info, how: pick.how, extra };
}

/** 加入者数・財務を読み直すまでの日数（年金機構のデータは半年ごとに入れ替わる） */
export const EXTRA_REFRESH_DAYS = 180;

const extraFields = (extra: GbizExtra | undefined) => ({
  gbizExtraAt: new Date().toISOString(),
  ...(extra?.insured ? { gbizInsured: extra.insured } : {}),
  ...(extra?.finance ? { gbizFinance: extra.finance } : {}),
});

const INTERVAL_MS = 1000;
const PER_RUN = 120;
const SCAN = 400;
const BUDGET_MS = 400_000;

/**
 * 企業情報（所在地）を読み終えた会社を、会社IDの順に少しずつ調べる（10分ごと）。
 * 最後まで行ったら先頭に戻り、あとから企業情報が入った会社を拾う。
 */
export async function gbizSweep(deps: {
  db: Firestore;
  get: GbizGet;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'gbiz', 540_000, async () => {
    const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    const until = Date.now() + (deps.budgetMs ?? BUDGET_MS);
    const metaRef = db.collection('meta').doc('gbiz');
    const meta = (await metaRef.get()).data() ?? {};
    let cursor = (meta.cursor as string | undefined) ?? '';
    const counts: Record<string, number> = {};
    let done = 0;
    let scanned = 0;
    let wrapped = false;
    let error: string | null = null;
    while (done < PER_RUN && Date.now() < until && !error) {
      let q = db.collection('companies').orderBy(FieldPath.documentId()).limit(SCAN);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) {
        if (wrapped || !cursor) break;
        cursor = '';
        wrapped = true;
        continue;
      }
      for (const d of snap.docs) {
        if (done >= PER_RUN || Date.now() >= until) break;
        const before = cursor;
        cursor = d.id;
        scanned++;
        const c = d.data();
        // 法人番号が決まった会社：加入者数・財務がまだ（または古い）なら読む
        const extraDue =
          Boolean(c.gbizAt && c.corporateNumber) &&
          (!c.gbizExtraAt || Date.now() - new Date(String(c.gbizExtraAt)).getTime() > EXTRA_REFRESH_DAYS * 86400e3);
        if (!extraDue && (c.gbizAt || !c.profileAt || !c.name)) continue;
        if (done > 0) await sleep(INTERVAL_MS);
        try {
          if (extraDue) {
            const extra = await lookupExtra(deps.get, sleep, String(c.corporateNumber));
            await d.ref.set(extraFields(extra), { merge: true });
            counts.extra = (counts.extra ?? 0) + 1;
            done++;
            continue;
          }
          const { info, how, extra } = await lookupCompany(deps.get, sleep, String(c.name), c.profile as CompanyProfile | undefined);
          await d.ref.set(
            {
              gbizAt: new Date().toISOString(),
              gbizMatch: how,
              ...(info ? { corporateNumber: info.corporateNumber, gbiz: info, ...extraFields(extra) } : {}),
            },
            { merge: true },
          );
          counts[info ? 'matched' : how] = (counts[info ? 'matched' : how] ?? 0) + 1;
          done++;
        } catch (e) {
          if (isBadRequest(e)) {
            // 受け付けられない問い合わせ（会社ごとに決まっていて、やり直しても同じ）：印を付けて次の会社へ
            const kind = e instanceof GbizHttpError ? e.kind : 'unknown';
            const at = new Date().toISOString();
            await d.ref.set(extraDue ? { gbizExtraAt: at, gbizExtraError: `400 ${kind}` } : { gbizAt: at, gbizMatch: 'error', gbizError: `400 ${kind}` }, { merge: true });
            counts[`bad_${kind}`] = (counts[`bad_${kind}`] ?? 0) + 1;
            done++;
            continue;
          }
          // 利用上限・一時的な不具合：ここで止めて、次の回に同じ会社から続ける
          error = String(e).slice(0, 200);
          cursor = before;
          break;
        }
      }
    }
    const result = { ...counts, scanned, cursor, ...(error ? { error } : {}) };
    await metaRef.set({ ...result, lastRunAt: new Date().toISOString() });
    return result;
  });
  if (!r.ran) return { skipped: true };
  deps.log?.('gbiz sweep', r.value);
  return r.value;
}

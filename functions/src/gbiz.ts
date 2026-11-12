import type { Firestore } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import { withLease } from './lease';
import type { CompanyProfile } from './company';

/**
 * gBizINFO（経済産業省）で、台帳の会社を法人番号と結びつけ、代表者・資本金・従業員数などを足す。
 * PR TIMES の会社名と「企業情報」の所在地（都道府県）で検索し、名前が一致する法人が1つに決まったときだけ結びつける。
 * 書き込み先: companies/{会社ID} の corporateNumber・gbiz・gbizAt・gbizMatch
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

export type GbizGet = (url: string) => Promise<Record<string, unknown>>;

export function gbizFetcher(token: string): GbizGet {
  return async (url) => {
    const res = await fetch(url, { headers: { 'X-hojinInfo-api-token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`gBizINFO ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
}

/** 1社を調べる。結びつけた法人番号（なければ null）と、調べ方 */
export async function lookupCompany(
  get: GbizGet,
  sleep: (ms: number) => Promise<void>,
  company: string,
  profile: CompanyProfile | undefined,
): Promise<{ info: GbizInfo | null; how: string }> {
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
  return { info: toGbizInfo(h ?? (pick.c as Record<string, unknown>)), how: pick.how };
}

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
        if (c.gbizAt || !c.profileAt || !c.name) continue;
        if (done > 0) await sleep(INTERVAL_MS);
        try {
          const { info, how } = await lookupCompany(deps.get, sleep, String(c.name), c.profile as CompanyProfile | undefined);
          await d.ref.set(
            { gbizAt: new Date().toISOString(), gbizMatch: how, ...(info ? { corporateNumber: info.corporateNumber, gbiz: info } : {}) },
            { merge: true },
          );
          counts[info ? 'matched' : how] = (counts[info ? 'matched' : how] ?? 0) + 1;
          done++;
        } catch (e) {
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

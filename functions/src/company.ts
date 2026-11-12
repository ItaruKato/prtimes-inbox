import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { companyIdOf } from './parse';
import { commitOps, httpGet, type Op } from './collect';
import { parseNewArrival } from './backfill';
import { withLease } from './lease';

/**
 * 会社の台帳づくり（Long List・Knowledge Base の土台）。
 * - companies/{会社ID}: name と profile（PR TIMES の記事ページ下の「企業情報」）
 * - companyArticles/{会社ID}: その会社の記事の一覧（a.{記事ID} = { t: タイトル, p: 配信日時 }）。過去1年分をさかのぼる
 * - profileQueue/{会社ID}: 企業情報をまだ読んでいない会社（url: その会社の記事）
 */

/** 記事ページの「企業情報」（PR TIMES に登録された会社の情報） */
export interface CompanyProfile {
  url?: string;
  industry?: string;
  address?: string;
  phone?: string;
  representative?: string;
  listed?: string;
  capital?: string;
  established?: string;
}

const LABELS: Record<string, keyof CompanyProfile> = {
  URL: 'url',
  業種: 'industry',
  本社所在地: 'address',
  電話番号: 'phone',
  代表者名: 'representative',
  上場: 'listed',
  資本金: 'capital',
  設立: 'established',
};

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** 記事ページから「企業情報」を読む。見つからなければ null */
export function parseCompanyProfile(html: string): CompanyProfile | null {
  const at = ['<dt>本社所在地</dt>', '<dt>代表者名</dt>', '<dt>業種</dt>'].map((k) => html.indexOf(k)).find((i) => i >= 0);
  if (at === undefined) return null;
  const start = html.lastIndexOf('<dl', at);
  const end = html.indexOf('</dl>', at);
  if (start < 0 || end < 0) return null;
  const dl = html.slice(start, end);
  const out: CompanyProfile = {};
  for (const m of dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const key = LABELS[text(m[1])];
    const v = text(m[2]).slice(0, 200);
    if (key && v && v !== '-') out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ---- 企業情報の読み込み（profileQueue を少しずつ減らす） ----

const PROFILE_PER_RUN = 150;
const PROFILE_INTERVAL_MS = 1500;
const PROFILE_BUDGET_MS = 400_000;
const PROFILE_MAX_TRIES = 3;

export async function profileSweep(deps: {
  db: Firestore;
  get?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'profileSweep', 540_000, async () => {
    const get = deps.get ?? httpGet;
    const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    const until = Date.now() + (deps.budgetMs ?? PROFILE_BUDGET_MS);
    const queue = await db.collection('profileQueue').limit(PROFILE_PER_RUN).get();
    let done = 0;
    let missing = 0;
    let failed = 0;
    for (const [i, q] of queue.docs.entries()) {
      if (Date.now() >= until) break;
      if (i > 0) await sleep(PROFILE_INTERVAL_MS);
      const url = q.get('url') as string;
      try {
        const profile = parseCompanyProfile(await get(url));
        const batch = db.batch();
        batch.set(
          db.collection('companies').doc(q.id),
          { profile: profile ?? {}, profileAt: new Date().toISOString() },
          { merge: true },
        );
        batch.delete(q.ref);
        await batch.commit();
        if (profile) done++;
        else missing++;
      } catch (e) {
        failed++;
        const tries = ((q.get('tries') as number | undefined) ?? 0) + 1;
        if (tries >= PROFILE_MAX_TRIES) await q.ref.delete();
        else await q.ref.set({ tries, lastError: String(e).slice(0, 200) }, { merge: true });
      }
    }
    const left = (await db.collection('profileQueue').count().get()).data().count;
    const result = { done, missing, failed, left };
    await db.collection('meta').doc('profiles').set({ lastRunAt: new Date().toISOString(), ...result }, { merge: true });
    return result;
  });
  if (!r.ran) return { skipped: true };
  deps.log?.('profile sweep', r.value);
  return r.value;
}

// ---- 過去1年分の記事を会社ごとにまとめる（companyArticles） ----

/** ここまでさかのぼる（JST） */
export const ARCHIVE_FROM = '2025-11-01T00:00:00+09:00';
const LIST_URL = 'https://prtimes.jp/main/html/newarrival';
const ARCHIVE_INTERVAL_MS = 2500;
const ARCHIVE_BUDGET_MS = 420_000;
/** 1日分を読むページ数の上限（1日 3,000件 ＝ 75ページを大きく超えたら、形が変わったとみなして止める） */
const MAX_PAGES_PER_DAY = 200;

interface ArchiveState {
  from: string;
  /** いま読んでいる日（JST の YYYY-MM-DD）。この日の 24:00 から古い方へ読む */
  day: string;
  /** 読みかけのカーソル（同じ日の続き） */
  cursor?: string | null;
  dayPages?: number;
  done?: boolean;
  pages?: number;
  items?: number;
  lastError?: string | null;
  lastRunAt?: string;
}

const dayStart = (day: string) => new Date(`${day}T00:00:00+09:00`).getTime();
const prevDay = (day: string) => new Date(dayStart(day) - 86400e3 + 9 * 3600e3).toISOString().slice(0, 10);
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/** 記事を会社ごとの一覧に足す書き込み（新しい会社は台帳に入れ、企業情報の読み込み待ちに並べる） */
export async function archiveOps(
  db: Firestore,
  items: { id: string; url: string; title: string; company?: string; publishedAt: string }[],
  /** 企業情報を読み終えた会社（読み込み待ちに並べない） */
  profiled: Set<string> = new Set(),
): Promise<Op[][]> {
  const by = new Map<string, typeof items>();
  for (const it of items) {
    const cid = companyIdOf(it.id);
    if (!cid || cid === 'NaN') continue;
    by.set(cid, [...(by.get(cid) ?? []), it]);
  }
  const cids = [...by.keys()];
  const known = new Set<string>();
  const hasProfile = new Set<string>();
  for (let i = 0; i < cids.length; i += 300) {
    const snaps = await db.getAll(...cids.slice(i, i + 300).map((c) => db.collection('companies').doc(c)));
    for (const s of snaps) {
      if (s.exists) known.add(s.id);
      if (s.get('profileAt')) hasProfile.add(s.id);
    }
  }
  const units: Op[][] = [];
  for (const [cid, list] of by) {
    const a = Object.fromEntries(list.map((it) => [it.id, { t: it.title.slice(0, 200), p: it.publishedAt }]));
    const name = list.find((it) => it.company)?.company ?? '';
    const unit: Op[] = [
      {
        bytes: JSON.stringify(a).length + 200,
        apply: (b) => b.set(db.collection('companyArticles').doc(cid), { ...(name ? { name } : {}), a }, { merge: true }),
      },
    ];
    if (!known.has(cid) && name) {
      unit.push({ bytes: 200, apply: (b) => b.set(db.collection('companies').doc(cid), { name, updatedAt: new Date().toISOString() }, { merge: true }) });
    }
    // 企業情報をまだ読んでいない会社は、読み込み待ちに並べる（前からある会社も、記事が出てきたときに並ぶ）
    if (!hasProfile.has(cid) && !profiled.has(cid) && (known.has(cid) || name)) {
      unit.push({
        bytes: 300,
        apply: (b) => b.set(db.collection('profileQueue').doc(cid), { url: list[0].url, at: FieldValue.serverTimestamp() }, { merge: true }),
      });
    }
    units.push(unit);
  }
  return units;
}

/**
 * 新着一覧を1日ずつ古い方へ読み、会社ごとの記事一覧（companyArticles）を作る。
 * 一覧のカーソルは「UNIX時刻_番号」なので、その日の 24:00 を指定すると、その日から読める。
 * 進み具合は meta/archive に保存し、何回かに分けて ARCHIVE_FROM まで進める。
 */
export async function archivePast(deps: {
  db: Firestore;
  get?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'archive', 540_000, async () => {
    const get = deps.get ?? httpGet;
    const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    const until = Date.now() + (deps.budgetMs ?? ARCHIVE_BUDGET_MS);
    const ref = db.collection('meta').doc('archive');
    const prev = ((await ref.get()).data() ?? {}) as Partial<ArchiveState>;
    const state: ArchiveState =
      prev.from === ARCHIVE_FROM && prev.day ? (prev as ArchiveState) : { from: ARCHIVE_FROM, day: todayJst() };
    if (state.done) return { done: true, pages: 0, items: 0 };
    const fromMs = new Date(ARCHIVE_FROM).getTime();

    let pages = 0;
    let stored = 0;
    let problem: string | null = null;
    while (Date.now() < until && !state.done) {
      const start = dayStart(state.day);
      const cursor = state.cursor ?? `${Math.floor((start + 86400e3) / 1000)}_9999999`;
      if (pages > 0) await sleep(ARCHIVE_INTERVAL_MS);
      let html: string;
      try {
        html = await get(`${LIST_URL}?pagination_cursor=${cursor}`);
      } catch (e) {
        problem = `一覧ページの取得に失敗: ${String(e).slice(0, 200)}`;
        break;
      }
      pages++;
      state.dayPages = (state.dayPages ?? 0) + 1;
      const { items, next } = parseNewArrival(html);
      if (!items.length) {
        // 一時的なエラーページか、ページの形が変わった。同じカーソルから次の回に読み直す
        problem = `${state.day}: 一覧ページに記事がありません（cursor=${cursor}）`;
        break;
      }
      const inDay = items.filter((it) => {
        const t = new Date(it.publishedAt).getTime();
        return t >= start && t < start + 86400e3;
      });
      if (inDay.length) {
        await commitOps(db, await archiveOps(db, inDay));
        stored += inDay.length;
      }
      const oldest = items.at(-1)?.publishedAt;
      const finishedDay = !next || (oldest !== undefined && new Date(oldest).getTime() < start);
      if (!finishedDay && state.dayPages > MAX_PAGES_PER_DAY) {
        problem = `${state.day} のページ数が多すぎます（${state.dayPages}ページ）。一覧の形が変わった可能性があります`;
        break;
      }
      if (finishedDay) {
        if (start <= fromMs) state.done = true;
        else state.day = prevDay(state.day);
        state.cursor = null;
        state.dayPages = 0;
      } else {
        state.cursor = next;
      }
    }
    state.pages = (state.pages ?? 0) + pages;
    state.items = (state.items ?? 0) + stored;
    state.lastError = problem;
    state.lastRunAt = new Date().toISOString();
    await ref.set(state);
    return { done: Boolean(state.done), day: state.day, pages, items: stored, ...(problem ? { problem } : {}) };
  });
  if (!r.ran) return { skipped: true };
  deps.log?.('archive run', r.value);
  return r.value;
}

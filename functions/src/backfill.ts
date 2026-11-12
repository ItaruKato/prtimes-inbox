import type { Firestore } from 'firebase-admin/firestore';
import { articleId } from './parse';
import type { RawItem } from './parse';
import { httpGet, store } from './collect';
import { withLease } from './lease';

/** ここまでさかのぼって取り込む（JST） */
export const BACKFILL_FROM = '2026-09-01T00:00:00+09:00';
/** 1回の実行で読む一覧ページ数（1ページ40件） */
const PAGES_PER_RUN = 60;
/** 一覧ページを読む間隔（PR TIMES への負荷を抑える） */
const PAGE_INTERVAL_MS = 2000;
/** 一覧ページを読む時間・記事ページ（会社名）を読む時間の上限（関数の制限時間 540 秒に収める） */
const LIST_BUDGET_MS = 300_000;
const STORE_BUDGET_MS = 420_000;
/** 同時に2つ動かないようにする期間（関数の制限時間と同じ） */
const LEASE_MS = 540_000;
const LIST_URL = 'https://prtimes.jp/main/html/newarrival';

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** "2026-11-09T01:29:19+0900" → "2026-11-09T01:29:19+09:00" */
const isoOffset = (s: string) => s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

/** 新着一覧ページ（40件）から記事と次ページのカーソルを取り出す */
export function parseNewArrival(html: string): { items: RawItem[]; next: string | null } {
  const items: RawItem[] = [];
  for (const art of html.match(/<article class="list-article"[\s\S]*?<\/article>/g) ?? []) {
    const href = art.match(/href="(\/main\/html\/rd\/p\/[\d.]+\.html)"/)?.[1];
    const id = href ? articleId(href) : null;
    const time = art.match(/datetime="([^"]+)"/)?.[1];
    if (!href || !id || !time) continue;
    const h3 = decode(art.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
    const alt = decode(art.match(/<img[^>]*alt="([^"]*)"/)?.[1] ?? '');
    // 見出しは長いと「...」で切れるので、画像の代替テキスト（全文）を優先する
    const head = h3.replace(/\.\.\.$|…$/, '');
    const title = alt && alt.startsWith(head.slice(0, 10)) ? alt : h3;
    const company = decode(
      art.match(/class="list-article__company-name-link"[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
        art.match(/class="list-article__company-name--dummy"[^>]*>([\s\S]*?)<\/span>/)?.[1] ??
        '',
    );
    items.push({ id, url: `https://prtimes.jp${href}`, title, company, publishedAt: isoOffset(time) });
  }
  const next = html.match(/pagination_cursor=([0-9_]+)"\s*class="list-article__more-link/)?.[1] ?? null;
  return { items, next };
}

interface BackfillState {
  from: string;
  cursor?: string | null;
  done?: boolean;
  pages?: number;
  items?: number;
  oldest?: string;
  /** 直近の回で起きた問題（一覧が読めない・形が変わったなど）。正常に進んだら消す */
  lastError?: string | null;
  lastRunAt?: string;
}

/**
 * 新着一覧をさかのぼって、BACKFILL_FROM 以降の記事を取り込む。
 * 進み具合は meta/backfill に保存し、何回かに分けて最後まで進める。
 * 終わりの判定は「BACKFILL_FROM より古い記事が出てきたとき」だけにする
 * （エラーページや形の変わったページで、途中なのに終わったことにならないように）。
 */
export async function backfill(deps: {
  db: Firestore;
  get?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  pagesPerRun?: number;
  /** 一覧ページを読む時間の上限（ミリ秒） */
  budgetMs?: number;
}) {
  const { db } = deps;
  const log = deps.log ?? (() => {});
  const r = await withLease(db, 'backfill', LEASE_MS, () => run(deps));
  if (!r.ran) {
    log('backfill skipped: previous run still in progress', { until: new Date(r.until).toISOString() });
    return { done: false, pages: 0, stored: 0, skipped: true };
  }
  return r.value;
}

async function run(deps: Parameters<typeof backfill>[0]) {
  const { db } = deps;
  const get = deps.get ?? httpGet;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const startedAt = Date.now();
  const listUntil = startedAt + (deps.budgetMs ?? LIST_BUDGET_MS);
  const ref = db.collection('meta').doc('backfill');
  const prev = ((await ref.get()).data() ?? {}) as Partial<BackfillState>;
  // さかのぼる日を古くしたときは、前回たどり着いた日（prev.from）の続きから読む
  // （一覧のカーソルは「UNIX時刻_番号」なので、その時刻より古い記事から読める）
  const state: BackfillState =
    prev.from === BACKFILL_FROM
      ? { ...prev, from: BACKFILL_FROM }
      : prev.from && new Date(prev.from).getTime() > new Date(BACKFILL_FROM).getTime()
        ? prev.done
          ? { from: BACKFILL_FROM, cursor: `${Math.floor(new Date(prev.from).getTime() / 1000)}_9999999`, pages: prev.pages, items: prev.items }
          : // 前回の取り込みが途中なら、そのカーソルのまま続ける
            { ...prev, from: BACKFILL_FROM, done: false }
        : { from: BACKFILL_FROM };
  if (state.done) return { done: true, pages: 0, stored: 0 };

  const fromMs = new Date(BACKFILL_FROM).getTime();
  const raws: RawItem[] = [];
  let pages = 0;
  let done = false;
  let problem: string | null = null;
  let cursor = state.cursor ?? null;
  while (pages < (deps.pagesPerRun ?? PAGES_PER_RUN) && Date.now() < listUntil) {
    if (pages > 0) await sleep(PAGE_INTERVAL_MS);
    let html: string;
    try {
      html = await get(cursor ? `${LIST_URL}?pagination_cursor=${cursor}` : LIST_URL);
    } catch (e) {
      // 読めたところまでは保存し、続きは次の回に同じカーソルから読む
      problem = `一覧ページの取得に失敗: ${String(e)}`;
      break;
    }
    pages++;
    const { items, next } = parseNewArrival(html);
    for (const it of items) if (new Date(it.publishedAt).getTime() >= fromMs) raws.push(it);
    const oldest = items.at(-1)?.publishedAt;
    if (oldest) state.oldest = oldest;
    if (oldest && new Date(oldest).getTime() < fromMs) {
      done = true;
      break;
    }
    if (!items.length || !next) {
      // まだ BACKFILL_FROM まで届いていないのに続きがない：一時的なエラーページか、ページの形が変わった
      problem = `一覧ページに${items.length ? '次ページへのリンク' : '記事'}がありません（cursor=${cursor ?? '最初'}）`;
      break;
    }
    cursor = next;
  }
  if (problem) log('backfill problem', { problem, cursor });

  const r = await store({ db, get, sleep, log, pageFetchUntil: startedAt + STORE_BUDGET_MS }, raws, 'backfillStore');
  const saved: BackfillState = {
    ...state,
    cursor,
    done,
    pages: (state.pages ?? 0) + pages,
    items: (state.items ?? 0) + r.added,
    lastError: problem,
    lastRunAt: new Date().toISOString(),
  };
  await ref.set(saved);
  log('backfill run', { pages, stored: r.added, done, oldest: state.oldest });
  return { done, pages, stored: r.added, oldest: state.oldest, ...(problem ? { problem } : {}) };
}

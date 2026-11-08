import type { Firestore } from 'firebase-admin/firestore';
import { bucketKey, companyIdOf, mergeRaw, parseArticlePage, parseNewsSitemap, parseRss, type RawItem } from './parse';
import { ruleJudge } from './judge';
import type { Article } from './types';

const UA = 'prtimes-inbox/1.0 (personal reader; hourly)';
const RSS_URL = 'https://prtimes.jp/index.rdf';
const SITEMAP_URL = 'https://prtimes.jp/sitemap-news.xml';

/** 1回の実行で記事ページを読みに行く上限と間隔（PR TIMES への負荷を抑える） */
const PAGE_FETCH_LIMIT = 150;
const PAGE_FETCH_INTERVAL_MS = 1000;

export async function httpGet(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

export interface CollectDeps {
  db: Firestore;
  get?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface CollectResult {
  seen: number;
  added: number;
  updated: number;
  pageFetches: number;
  missingCompany: number;
}

/**
 * 新着を取得して Firestore に保存する。
 * 保存先: buckets/{JSTのYYYYMMDDHH} の items.{記事ID}（1時間分を1ドキュメントにまとめ、画面の読み込み回数を抑える）
 * 会社名: companies/{会社ID} にキャッシュし、初めて見る会社だけ記事ページを読む
 */
export async function collect(deps: CollectDeps): Promise<CollectResult> {
  const get = deps.get ?? httpGet;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const { db } = deps;

  const [rssBody, sitemapBody] = await Promise.all([get(RSS_URL), get(SITEMAP_URL)]);
  const merged = mergeRaw(parseRss(rssBody), parseNewsSitemap(sitemapBody));
  const raws = [...merged.values()].filter((r) => r.publishedAt && r.title);

  // 既に保存済みの記事（会社名が埋まっているもの）は飛ばす
  const byBucket = new Map<string, RawItem[]>();
  for (const r of raws) {
    const k = bucketKey(r.publishedAt);
    const list = byBucket.get(k);
    if (list) list.push(r);
    else byBucket.set(k, [r]);
  }
  const bucketRefs = [...byBucket.keys()].map((k) => db.collection('buckets').doc(k));
  const bucketSnaps = bucketRefs.length ? await db.getAll(...bucketRefs) : [];
  const existing = new Map<string, Article>();
  for (const s of bucketSnaps) {
    const items = (s.data()?.items ?? {}) as Record<string, Article>;
    for (const [id, a] of Object.entries(items)) existing.set(id, a);
  }
  const todo = raws.filter((r) => {
    const e = existing.get(r.id);
    return !e || !e.company;
  });

  // 会社名：RSS → キャッシュ → 記事ページ
  const companyIds = [...new Set(todo.map((r) => companyIdOf(r.id)))];
  const companyCache = new Map<string, { name: string }>();
  for (let i = 0; i < companyIds.length; i += 300) {
    const refs = companyIds.slice(i, i + 300).map((c) => db.collection('companies').doc(c));
    for (const s of await db.getAll(...refs)) if (s.exists) companyCache.set(s.id, s.data() as { name: string });
  }
  const sections = new Map<string, string>();
  const newCompanies = new Map<string, string>();
  for (const r of todo) if (r.company) newCompanies.set(companyIdOf(r.id), r.company);

  let pageFetches = 0;
  for (const r of todo) {
    const cid = companyIdOf(r.id);
    if (r.company || companyCache.has(cid) || newCompanies.has(cid)) continue;
    if (pageFetches >= PAGE_FETCH_LIMIT) break;
    if (pageFetches > 0) await sleep(PAGE_FETCH_INTERVAL_MS);
    pageFetches++;
    try {
      const page = parseArticlePage(await get(r.url));
      if (page?.company) newCompanies.set(cid, page.company);
      if (page?.section) sections.set(r.id, page.section);
    } catch (e) {
      log('article page fetch failed', { url: r.url, error: String(e) });
    }
  }

  const fetchedAt = now().toISOString();
  let added = 0;
  let updated = 0;
  let missingCompany = 0;
  const writes = new Map<string, Record<string, Article>>();
  for (const r of todo) {
    const cid = companyIdOf(r.id);
    const prev = existing.get(r.id);
    const company = r.company || companyCache.get(cid)?.name || newCompanies.get(cid) || '';
    if (!company) missingCompany++;
    const base = {
      id: r.id,
      url: r.url,
      title: r.title,
      company,
      companyId: cid,
      publishedAt: r.publishedAt,
      lead: r.lead || prev?.lead || '',
      keywords: r.keywords?.length ? r.keywords : prev?.keywords ?? [],
      ticker: r.ticker || prev?.ticker || '',
      section: sections.get(r.id) || prev?.section || '',
    };
    const article: Article = { ...base, ai: prev?.ai ?? ruleJudge(base), fetchedAt: prev?.fetchedAt ?? fetchedAt };
    if (prev) updated++;
    else added++;
    const k = bucketKey(r.publishedAt);
    const w = writes.get(k) ?? {};
    w[r.id] = article;
    writes.set(k, w);
  }

  // 書き込み（バケットごとに items をマージ）
  const batch = db.batch();
  for (const [k, items] of writes) batch.set(db.collection('buckets').doc(k), { items, updatedAt: fetchedAt }, { merge: true });
  for (const [cid, name] of newCompanies)
    if (!companyCache.has(cid)) batch.set(db.collection('companies').doc(cid), { name, updatedAt: fetchedAt });
  batch.set(db.collection('meta').doc('collector'), { lastRunAt: fetchedAt, seen: raws.length, added, updated }, { merge: true });
  await batch.commit();

  const result = { seen: raws.length, added, updated, pageFetches, missingCompany };
  log('collect done', { ...result });
  return result;
}

import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import { BUCKET_MAX_BYTES, BucketPlanner, KEYWORDS_MAX, LEAD_MAX, loadBuckets, valueSize } from './buckets';
import { bucketKey, companyIdOf, mergeRaw, parseArticlePage, parseNewsSitemap, parseRss, type RawItem } from './parse';
import { ruleJudge } from './judge';
import { indexOps } from './dayIndex';
import type { Article } from './types';
import { archiveOps, parseCompanyProfile, type CompanyProfile } from './company';

const UA = 'prtimes-inbox/1.0 (personal reader; hourly)';
const RSS_URL = 'https://prtimes.jp/index.rdf';
const SITEMAP_URL = 'https://prtimes.jp/sitemap-news.xml';

/** 1回の実行で記事ページを読みに行く上限と間隔（PR TIMES への負荷を抑える） */
const PAGE_FETCH_LIMIT = 150;
const PAGE_FETCH_INTERVAL_MS = 1000;
/** 記事ページを読みに行ってよい時間（関数の制限時間 540 秒に収める。PR TIMES が遅いときも書き込みまで終わるように） */
const PAGE_FETCH_BUDGET_MS = 240_000;
/** 1回のバッチ書き込みの上限（Firestore は 500 件・10 MiB まで） */
const BATCH_OPS = 450;
const BATCH_BYTES = 4_000_000;

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
  /** 記事ページを読みに行くのをやめる時刻（ミリ秒。省略時は今から PAGE_FETCH_BUDGET_MS 後） */
  pageFetchUntil?: number;
}

export interface CollectResult {
  seen: number;
  added: number;
  updated: number;
  pageFetches: number;
  missingCompany: number;
  /** 書き込んだバケットのドキュメント数（続きのドキュメントを含む） */
  docs: number;
}

/**
 * 新着を取得して Firestore に保存する。
 * 保存先: buckets/{JSTのYYYYMMDDHH} の items.{記事ID}（1時間分を1ドキュメントにまとめ、画面の読み込み回数を抑える）
 * 1時間分が大きすぎるときは buckets/{YYYYMMDDHH}_2, _3 … に分ける（buckets.ts）
 * 会社名: companies/{会社ID} にキャッシュし、初めて見る会社だけ記事ページを読む
 */
export async function collect(deps: CollectDeps): Promise<CollectResult> {
  const get = deps.get ?? httpGet;
  const [rssBody, sitemapBody] = await Promise.all([get(RSS_URL), get(SITEMAP_URL)]);
  const merged = mergeRaw(parseRss(rssBody), parseNewsSitemap(sitemapBody));
  return store(deps, [...merged.values()], 'collector');
}

/** 1回の書き込み（バッチに入れる操作と、その大きさの見積もり） */
export interface Op {
  bytes: number;
  apply: (b: WriteBatch) => void;
}

/** 操作をまとめてバッチで書き込む（500件・10 MiB の上限に収まるように分ける） */
export async function commitOps(db: Firestore, units: Op[][]): Promise<void> {
  let batch = db.batch();
  let ops = 0;
  let bytes = 0;
  for (const unit of units) {
    const ub = unit.reduce((n, o) => n + o.bytes, 0);
    // 1つのまとまり（記事の移動など）は同じバッチに入れる
    if (ops > 0 && (ops + unit.length > BATCH_OPS || bytes + ub > BATCH_BYTES)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
      bytes = 0;
    }
    for (const o of unit) o.apply(batch);
    ops += unit.length;
    bytes += ub;
  }
  if (ops > 0) await batch.commit();
}

/**
 * 記事を保存する（新着取得とさかのぼり取得で共通）。
 * 既に保存済みの記事は飛ばし、会社名は RSS・一覧 → キャッシュ → 記事ページ の順で埋める。
 */
export async function store(deps: CollectDeps, input: RawItem[], label: string): Promise<CollectResult> {
  const get = deps.get ?? httpGet;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const pageFetchUntil = deps.pageFetchUntil ?? Date.now() + PAGE_FETCH_BUDGET_MS;
  const { db } = deps;
  // 日時が読めないものは捨てる（"NaN..." という名前のバケットができ、画面にも cleanup にも引っかかってしまうため）
  // 同じ記事が2回来たら1件にまとめる（別々のドキュメントに入らないように）
  const raws = [
    ...mergeRaw(input.filter((r) => r.id && r.title && r.publishedAt && Number.isFinite(new Date(r.publishedAt).getTime()))).values(),
  ];

  // 既に保存済みの記事（会社名が埋まっているもの）は飛ばす。続きのドキュメント（_2, _3 …）も見る
  const hours = [...new Set(raws.map((r) => bucketKey(r.publishedAt)))];
  const planner = new BucketPlanner(hours.length ? await loadBuckets(db, hours) : []);
  const todo = raws.filter((r) => {
    const e = planner.get(r.id);
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
  const profiles = new Map<string, CompanyProfile>();
  const newCompanies = new Map<string, string>();
  for (const r of todo) if (r.company) newCompanies.set(companyIdOf(r.id), r.company);

  let pageFetches = 0;
  for (const r of todo) {
    const cid = companyIdOf(r.id);
    if (r.company || companyCache.has(cid) || newCompanies.has(cid)) continue;
    if (pageFetches >= PAGE_FETCH_LIMIT || Date.now() >= pageFetchUntil) break;
    if (pageFetches > 0) await sleep(PAGE_FETCH_INTERVAL_MS);
    pageFetches++;
    try {
      const html = await get(r.url);
      const page = parseArticlePage(html);
      if (page?.company) newCompanies.set(cid, page.company);
      // 記事ページ下の「企業情報」（所在地・代表者・電話番号など）も台帳に入れる
      const profile = parseCompanyProfile(html);
      if (profile) profiles.set(cid, profile);
      if (page?.section) sections.set(r.id, page.section);
    } catch (e) {
      log('article page fetch failed', { url: r.url, error: String(e) });
    }
  }

  const fetchedAt = now().toISOString();
  let added = 0;
  let updated = 0;
  let missingCompany = 0;
  const writes = new Map<string, Record<string, Partial<Article>>>(); // ドキュメントID → 書き込む記事
  const indexed: Article[] = []; // 目次（days）に載せる記事
  const fresh: Article[] = []; // 新しく入った記事（会社ごとの記事一覧にも足す）
  for (const r of todo) {
    const cid = companyIdOf(r.id);
    const prev = planner.get(r.id);
    const company = r.company || companyCache.get(cid)?.name || newCompanies.get(cid) || '';
    if (!company) missingCompany++;
    const base = {
      id: r.id,
      url: r.url,
      title: r.title,
      company,
      companyId: cid,
      publishedAt: r.publishedAt,
      lead: (r.lead || prev?.lead || '').slice(0, LEAD_MAX),
      keywords: (r.keywords?.length ? r.keywords : prev?.keywords ?? []).slice(0, KEYWORDS_MAX),
      ticker: r.ticker || prev?.ticker || '',
      section: sections.get(r.id) || prev?.section || '',
    };
    const article: Article = { ...base, ai: prev?.ai ?? ruleJudge(base), fetchedAt: prev?.fetchedAt ?? fetchedAt };
    let docId: string;
    let write: Partial<Article>;
    const prevDoc = planner.where(r.id);
    if (prev && prevDoc) {
      // 保存済みの記事は同じドキュメントのまま更新する。ai は書かない
      // （判定・要約が同時に書き込んでいても上書きしないように。マージなので元の値が残る）
      updated++;
      docId = prevDoc;
      planner.replace(docId, r.id, article);
      write = prev.ai ? base : { ...base, ai: article.ai };
    } else {
      added++;
      docId = planner.place(bucketKey(r.publishedAt), r.id, article);
      write = article;
      if (company) fresh.push(article);
    }
    const w = writes.get(docId) ?? {};
    w[r.id] = write;
    writes.set(docId, w);
    indexed.push(prev?.ai ? { ...article, ai: prev.ai } : article);
  }

  // 書き込み（ドキュメントごとに items をマージ）
  const units: Op[][] = [];
  for (const [docId, items] of writes) {
    const size = planner.size(docId);
    if (size && size.bytes > BUCKET_MAX_BYTES) log('bucket too large', { docId, ...size });
    units.push([
      {
        bytes: valueSize(items) + 200,
        apply: (b) => b.set(db.collection('buckets').doc(docId), { items, updatedAt: fetchedAt }, { merge: true }),
      },
    ]);
  }
  units.push(...indexOps(db, indexed));
  for (const [cid, name] of newCompanies)
    if (!companyCache.has(cid)) {
      const profile = profiles.get(cid);
      units.push([
        {
          bytes: 600,
          apply: (b) =>
            b.set(
              db.collection('companies').doc(cid),
              { name, updatedAt: fetchedAt, ...(profile ? { profile, profileAt: fetchedAt } : {}) },
              { merge: true },
            ),
        },
      ]);
    }
  // 会社ごとの記事一覧（companyArticles）。企業情報をまだ読んでいない新しい会社は読み込み待ちに並べる
  units.push(...(await archiveOps(db, fresh, new Set(profiles.keys()))));
  units.push([
    {
      bytes: 200,
      apply: (b) =>
        b.set(db.collection('meta').doc(label), { lastRunAt: fetchedAt, seen: raws.length, added, updated }, { merge: true }),
    },
  ]);
  await commitOps(db, units);

  const result = { seen: raws.length, added, updated, pageFetches, missingCompany, docs: writes.size };
  log(`${label} done`, { ...result });
  return result;
}

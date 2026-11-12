import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { withLease } from './lease';
import { addUsage, DRAFT_MODEL } from './notes';
import { coreName } from './gbiz';
import type { CompanyProfile } from './company';

/**
 * 会社 HP の読み込み（台帳の処理。Long List・Knowledge Base で共通に使う）。
 * - 依頼：webQueue/{会社ID}（Knowledge Base が読んだ会社を自動で、会社ページのボタンでも依頼する。Long List も依頼してよい）
 * - HP の住所：PR TIMES の企業情報 → gBizINFO → なければ AI の Web 検索で探す（会社名がページにあるときだけ使う）
 * - 読み方：robots.txt を守り、トップと会社概要などのページを5ページまで、1.5秒あけて読む
 * - AI（Claude）が、正式な会社名・所在地・従業員数・資本金・売上高を、出どころのページ付きで拾う
 * - 書く：companies/{会社ID}.web・webAt（拾った項目）、companyWeb/{会社ID}（読んだページの本文。売上・決算公告などをあとで拾い直すときに使う）
 */

export const WEB_V = 1;
const UA = 'prtimes-inbox/1.0 (personal reader; company profile)';
const PAGE_MAX_BYTES = 2_000_000;
const TEXT_PER_PAGE = 12_000;
const MAX_PAGES = 5;
const INTERVAL_MS = 1500;
/** 読み直すまでの日数（依頼の redo があればすぐ） */
const REFRESH_DAYS = 180;
const PER_RUN = 6;
const MAX_TRIES = 3;

// ---- 安全に読める住所か（社内のサーバーなどを読みに行かない） ----

/** http(s) の普通のサイトだけ。IP アドレス・localhost・社内向けの名前・80/443 以外のポートは読まない */
export function safeUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let s = raw.normalize('NFKC').trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h) || h.startsWith('metadata')) return null;
  u.hash = '';
  return u;
}

// ---- robots.txt ----

/** robots.txt で、この UA が path を読んでよいか（User-agent: * と、名前に prtimes を含むものだけを見る） */
export function robotsAllows(txt: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; p: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      lastWasAgent = false;
      if (val) cur.rules.push({ allow: key === 'allow', p: val });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && 'prtimes-inbox'.includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of use)
    for (const r of g.rules) {
      const re = new RegExp('^' + r.p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.p.length > best.len || (r.p.length === best.len && r.allow))) best = { allow: r.allow, len: r.p.length };
    }
  return best ? best.allow : true;
}

// ---- ページの文字 ----

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

export function pageTitle(html: string): string {
  return decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** HTML を読みやすい文字にする（表の行は「｜」でつなぐ） */
export function htmlText(html: string, max = TEXT_PER_PAGE): string {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(td|th|dd|dt)>/gi, '｜')
      .replace(/<(br|\/p|\/h\d|\/li|\/tr|\/dl|\/div|\/section)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t　]+/g, ' ')
    .replace(/ ?｜ ?/g, '｜')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, max);
}

const LINK_WORDS = /会社概要|会社案内|会社情報|企業情報|企業概要|会社紹介|会社データ|基本情報|about|company|corporate|profile|outline|overview|gaiyou|gaiyo|ir\b|決算|財務|電子公告/i;

/** 同じサイトの中で、会社概要などのページへのリンクを選ぶ（多いほどよい順） */
export function pickLinks(html: string, base: URL, max = MAX_PAGES - 1): string[] {
  const out = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try {
      u = new URL(decode(m[1]), base);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!/^https?:$/.test(u.protocol) || /\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) continue;
    u.hash = '';
    const text = htmlText(m[2], 80);
    const score = (LINK_WORDS.test(text) ? 2 : 0) + (LINK_WORDS.test(u.pathname) ? 1 : 0) + (/会社概要|企業情報|会社情報|outline|profile/i.test(text + u.pathname) ? 1 : 0);
    if (!score) continue;
    const key = u.toString();
    if (key === base.toString()) continue;
    out.set(key, Math.max(out.get(key) ?? 0, score));
  }
  return [...out]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([k]) => k);
}

// ---- 読みに行く ----

export interface FetchResult {
  url: string;
  status: number;
  type: string;
  body: string;
}
export type WebGet = (url: string) => Promise<FetchResult>;

/** 本番の読み方。転送先も安全な住所か確かめ、HTML・文字だけ、2MB まで */
export const webGet: WebGet = async (start) => {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    if (!safeUrl(url)) throw new Error('読めない住所です');
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return { url, status: res.status, type, body: '' };
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, PAGE_MAX_BYTES);
    const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4000).toString('latin1'))?.[1] ?? 'utf-8';
    let body: string;
    try {
      body = new TextDecoder(/shift[_-]?jis|sjis|x-sjis/i.test(charset) ? 'shift_jis' : /euc-jp/i.test(charset) ? 'euc-jp' : 'utf-8').decode(buf);
    } catch {
      body = buf.toString('utf8');
    }
    return { url, status: res.status, type, body };
  }
  throw new Error('転送が多すぎます');
};

export interface Page {
  url: string;
  title: string;
  text: string;
}

/** トップと会社概要などのページを読む（robots.txt を守る） */
export async function readSite(home: URL, get: WebGet, sleep: (ms: number) => Promise<void>): Promise<{ pages: Page[]; blocked: boolean }> {
  let robots = '';
  try {
    const r = await get(new URL('/robots.txt', home).toString());
    if (r.status === 200) robots = r.body;
  } catch {
    /* robots.txt がなければ読んでよい */
  }
  const ok = (u: URL) => robotsAllows(robots, u.pathname + u.search);
  if (!ok(home)) return { pages: [], blocked: true };
  await sleep(INTERVAL_MS);
  const top = await get(home.toString());
  if (top.status >= 400 || !top.body) throw new Error(`HP を読めませんでした（${top.status}）`);
  const finalHome = safeUrl(top.url) ?? home;
  const pages: Page[] = [{ url: top.url, title: pageTitle(top.body), text: htmlText(top.body) }];
  for (const link of pickLinks(top.body, finalHome)) {
    const u = safeUrl(link);
    if (!u || !ok(u)) continue;
    await sleep(INTERVAL_MS);
    try {
      const r = await get(u.toString());
      if (r.status < 400 && r.body) pages.push({ url: r.url, title: pageTitle(r.body), text: htmlText(r.body) });
    } catch {
      /* 1ページ読めなくても続ける */
    }
    if (pages.length >= MAX_PAGES) break;
  }
  return { pages, blocked: false };
}

// ---- HP を探す（台帳にないとき） ----

/** その会社のページらしいか（法人格を除いた名前がページの文字にある） */
export function looksLikeCompany(name: string, pages: Page[]): boolean {
  const core = coreName(name);
  if (core.length < 2) return false;
  const hay = coreName(pages.map((p) => `${p.title}\n${p.text.slice(0, 6000)}`).join('\n'));
  return hay.includes(core);
}

export const SEARCH_SYSTEM = `あなたは日本企業の公式サイト（ホームページ）を探す係です。Web 検索で、指定された会社の公式サイトのトップページの URL を探します。
- 会社自身のサイトだけを答える。求人サイト・ニュース・SNS・企業データベース・PR TIMES・親会社の別ページは答えない
- 所在地が分かっているときは、所在地が合う会社を選ぶ。同名の別会社に注意する
- 最後の行に「URL: https://...」と1行だけ書く。見つからないときは「URL: なし」と書く`;

/** AI の Web 検索で公式サイトを探す（最大3回検索） */
export async function searchHomepage(client: Anthropic, db: Firestore, name: string, address: string | undefined): Promise<string | null> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: `会社名: ${name}\n所在地: ${address || '（不明）'}\n\nこの会社の公式サイトのトップページの URL を探してください。` },
  ];
  for (let turn = 0; turn < 4; turn++) {
    const r = await client.beta.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SEARCH_SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'JP' } }],
      messages,
    });
    await addUsage(db, {
      model: r.model ?? DRAFT_MODEL,
      input: r.usage.input_tokens,
      output: r.usage.output_tokens,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
    });
    if (r.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: r.content });
      continue;
    }
    if (r.stop_reason === 'refusal') return null;
    const text = r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const m = /URL:\s*(https?:\/\/\S+)/i.exec(text);
    return m ? m[1].replace(/[)）」』、。,]+$/, '') : null;
  }
  return null;
}

// ---- 項目を拾う ----

const Item = z.object({ value: z.string(), asOf: z.string(), source: z.string() });
export const WebOut = z.object({
  isCompanySite: z.boolean(),
  officialName: Item,
  address: Item,
  employees: Item,
  capital: Item,
  sales: Item,
});
export type WebItem = z.infer<typeof Item>;
export type WebFields = z.infer<typeof WebOut>;

export const EXTRACT_SYSTEM = `あなたは会社のホームページから会社概要の項目を書き写す係です。渡されたページ（URL ごと）の文字から、次の項目を探します。
ページに書かれていることだけを書き、推測や計算はしません。見つからない項目は value・asOf・source を空文字にします。

isCompanySite: 渡されたページが、指定された会社自身のサイトなら true（別の会社・求人サイト・データベースなら false）。
officialName: 正式な会社名（「株式会社」などの法人格を含む）。
address: 本社の所在地（郵便番号があれば含める）。
employees: 従業員数（例: 120名、連結 1,200名）。グループ・連結・単体の区別が書いてあれば value に含める。
capital: 資本金（例: 1億円、5,000万円）。
sales: 売上高（例: 32億円）。売上高・売上・営業収益として書かれた数字だけ。決算期・年度を asOf に書く。
asOf: その数字がいつ時点のものか（例: 2025年3月期、2025年4月1日現在）。書いていなければ空文字。
source: その項目を見つけたページの URL（渡された URL のどれか）。`;

/** 出どころが読んだページにない項目・会社のサイトでないときは捨てる */
export function tidyWeb(o: WebFields, urls: Set<string>) {
  const keep = (i: WebItem) => (o.isCompanySite && i.value.trim() && urls.has(i.source) ? { value: i.value.trim().slice(0, 120), asOf: i.asOf.trim().slice(0, 40), source: i.source } : null);
  return {
    officialName: keep(o.officialName),
    address: keep(o.address),
    employees: keep(o.employees),
    capital: keep(o.capital),
    sales: keep(o.sales),
  };
}

export async function extractFields(client: Anthropic, db: Firestore, name: string, pages: Page[]): Promise<{ fields: ReturnType<typeof tidyWeb>; isCompanySite: boolean; model: string }> {
  const content = `会社: ${name}\n\n${pages.map((p) => `=== ページ: ${p.url}\nタイトル: ${p.title}\n${p.text}`).join('\n\n')}`;
  const r = await client.beta.messages.parse({
    model: DRAFT_MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(WebOut) },
    system: [{ type: 'text', text: EXTRACT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });
  await addUsage(db, { model: r.model ?? DRAFT_MODEL, input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens ?? 0 });
  const o = r.parsed_output;
  if (r.stop_reason === 'refusal' || !o) throw new Error(`項目を拾えませんでした（${r.stop_reason}）`);
  return { fields: tidyWeb(o, new Set(pages.map((p) => p.url))), isCompanySite: o.isCompanySite, model: r.model ?? DRAFT_MODEL };
}

// ---- 依頼を処理する ----

export async function readCompanyWeb(
  deps: { db: Firestore; client: () => Anthropic; get?: WebGet; sleep?: (ms: number) => Promise<void> },
  cid: string,
): Promise<'done' | 'nosite' | 'blocked' | 'notfound'> {
  const { db } = deps;
  const get = deps.get ?? webGet;
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  const ref = db.collection('companies').doc(cid);
  const c = (await ref.get()).data() ?? {};
  const name = String(c.name ?? '');
  if (!name) return 'notfound';
  const profile = (c.profile ?? {}) as CompanyProfile;
  const gbizUrl = (c.gbiz as { url?: string } | undefined)?.url;
  const tries: { url: URL; from: string }[] = [];
  for (const [raw, from] of [
    [profile.url, 'profile'],
    [gbizUrl, 'gbiz'],
  ] as const) {
    const u = safeUrl(raw);
    if (u && !tries.some((t) => t.url.hostname === u.hostname)) tries.push({ url: u, from });
  }

  let pages: Page[] = [];
  let used: { url: URL; from: string } | null = null;
  let blocked = false;
  for (const t of tries) {
    try {
      const r = await readSite(t.url, get, sleep);
      if (r.blocked) {
        blocked = true;
        continue;
      }
      if (r.pages.length) {
        pages = r.pages;
        used = t;
        break;
      }
    } catch {
      /* 次の候補へ */
    }
  }
  // 台帳に HP がない・読めないときは、AI の Web 検索で探す（会社名がページにあるときだけ使う）
  if (!used && !blocked) {
    const found = safeUrl((await searchHomepage(deps.client(), db, name, profile.address)) ?? undefined);
    if (found) {
      try {
        const r = await readSite(found, get, sleep);
        if (r.blocked) blocked = true;
        else if (r.pages.length && looksLikeCompany(name, r.pages)) {
          pages = r.pages;
          used = { url: found, from: 'search' };
        }
      } catch {
        /* 見つからなかった扱い */
      }
    }
  }
  const at = new Date().toISOString();
  if (!used) {
    await ref.set({ web: { v: WEB_V, state: blocked ? 'blocked' : 'nosite', at }, webAt: at }, { merge: true });
    return blocked ? 'blocked' : 'nosite';
  }
  const { fields, isCompanySite, model } = await extractFields(deps.client(), db, name, pages);
  const b = db.batch();
  b.set(
    ref,
    {
      web: { v: WEB_V, state: isCompanySite ? 'done' : 'nosite', url: used.url.toString(), urlFrom: used.from, pages: pages.map((p) => p.url), ...fields, model, at },
      webAt: at,
    },
    { merge: true },
  );
  b.set(db.collection('companyWeb').doc(cid), { v: WEB_V, url: used.url.toString(), pages, at });
  await b.commit();
  return isCompanySite ? 'done' : 'nosite';
}

/** webQueue の依頼を少しずつ処理する（5分ごと）。新しすぎる情報があれば読み直さない（redo なら読む） */
export async function webSweep(deps: {
  db: Firestore;
  client: () => Anthropic;
  get?: WebGet;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'web', 290_000, async () => {
    const until = Date.now() + (deps.budgetMs ?? 200_000);
    const q = await db.collection('webQueue').orderBy('at').limit(PER_RUN * 3).get();
    const counts: Record<string, number> = {};
    for (const d of q.docs) {
      if (Date.now() >= until) break;
      const company = await db.collection('companies').doc(d.id).get();
      const webAt = company.get('webAt') as string | undefined;
      if (!d.get('redo') && webAt && Date.now() - new Date(webAt).getTime() < REFRESH_DAYS * 86400e3) {
        await d.ref.delete();
        counts.fresh = (counts.fresh ?? 0) + 1;
        continue;
      }
      try {
        const res = await readCompanyWeb(deps, d.id);
        counts[res] = (counts[res] ?? 0) + 1;
        await d.ref.delete();
      } catch (e) {
        const tries = Number(d.get('tries') ?? 0) + 1;
        counts.failed = (counts.failed ?? 0) + 1;
        deps.log?.('web failed', { error: String(e).slice(0, 200) });
        if (tries >= MAX_TRIES) {
          await company.ref.set({ web: { v: WEB_V, state: 'failed', error: String(e).slice(0, 200), at: new Date().toISOString() } }, { merge: true });
          await d.ref.delete();
        } else await d.ref.set({ tries, lastError: String(e).slice(0, 200), at: FieldValue.serverTimestamp() }, { merge: true });
      }
      if (Object.values(counts).reduce((a, b) => a + b, 0) >= PER_RUN) break;
    }
    const left = (await db.collection('webQueue').count().get()).data().count;
    return { ...counts, left };
  });
  if (!r.ran) return { skipped: true };
  if (Object.keys(r.value).some((k) => k !== 'left')) deps.log?.('web sweep', r.value);
  return r.value;
}

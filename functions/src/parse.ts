import { XMLParser } from 'fast-xml-parser';

/** 取得元から読み取った記事の断片（RSS とサイトマップで取れる項目が違う） */
export interface RawItem {
  id: string;
  url: string;
  title: string;
  company?: string;
  publishedAt: string;
  lead?: string;
  keywords?: string[];
  ticker?: string;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', trimValues: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v);

/** 記事URLから ID（リリース番号.会社ID）を取り出す */
export function articleId(url: string): string | null {
  const m = url.match(/\/main\/html\/rd\/p\/(\d+\.\d+)\.html/);
  return m ? m[1] : null;
}
export const companyIdOf = (id: string) => String(parseInt(id.split('.')[1], 10));

/** https://prtimes.jp/index.rdf（最新約200件。会社名と本文冒頭が取れる） */
export function parseRss(body: string): RawItem[] {
  const doc = xml.parse(body);
  const items = arr(doc?.['rdf:RDF']?.item);
  const out: RawItem[] = [];
  for (const it of items) {
    const url = text(it.link);
    const id = articleId(url);
    if (!id) continue;
    const lead = text(it.description).replace(/^\[[^\]]*\]\s*/, '');
    out.push({
      id,
      url,
      title: text(it.title),
      company: text(it['dc:corp']),
      publishedAt: text(it['dc:date']),
      lead: cleanLead(lead),
    });
  }
  return out;
}

/** https://prtimes.jp/sitemap-news.xml（当日分。キーワードと証券コードが取れる） */
export function parseNewsSitemap(body: string): RawItem[] {
  const doc = xml.parse(body);
  const urls = arr(doc?.urlset?.url);
  const out: RawItem[] = [];
  for (const u of urls) {
    const url = text(u.loc);
    const id = articleId(url);
    if (!id) continue;
    const n = u['news:news'] ?? {};
    out.push({
      id,
      url,
      title: text(n['news:title']),
      publishedAt: text(n['news:publication_date']),
      keywords: text(n['news:keywords']).split(',').map((s) => s.trim()).filter(Boolean),
      ticker: text(n['news:stock_tickers']).trim(),
    });
  }
  return out;
}

/** 記事ページの構造化データから会社名とリリース種別を取る */
export function parseArticlePage(html: string): { company: string; section: string } | null {
  const m = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const ld = JSON.parse(m[1]);
    const a = Array.isArray(ld) ? ld.find((x) => x['@type'] === 'NewsArticle') ?? ld[0] : ld;
    return { company: String(a?.author?.name ?? ''), section: String(a?.articleSection ?? '') };
  } catch {
    return null;
  }
}

export function cleanLead(s: string): string {
  return s
    .replace(/\[画像\d*[:：][^\]]*\]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 300);
}

/** RSS とサイトマップを ID で突き合わせて1件にまとめる */
export function mergeRaw(...lists: RawItem[][]): Map<string, RawItem> {
  const m = new Map<string, RawItem>();
  for (const list of lists)
    for (const it of list) {
      const cur = m.get(it.id);
      if (!cur) {
        m.set(it.id, { ...it });
        continue;
      }
      for (const [k, v] of Object.entries(it) as [keyof RawItem, RawItem[keyof RawItem]][]) {
        const empty = cur[k] === undefined || cur[k] === '' || (Array.isArray(cur[k]) && (cur[k] as string[]).length === 0);
        if (empty && v !== undefined) (cur as unknown as Record<string, unknown>)[k] = v;
      }
    }
  return m;
}

/** 配信日時（+09:00）から保存先の時間バケット（JST の YYYYMMDDHH）を作る */
export function bucketKey(publishedAt: string): string {
  const t = new Date(publishedAt).getTime() + 9 * 3600e3;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/** 記事ページから本文テキストを取り出す（要約用） */
export function extractBody(html: string, maxChars = 6000): string {
  const i = html.indexOf('id="press-release-body"');
  if (i < 0) return '';
  // 本文の <div> の閉じタグまでを取る（入れ子の div を数える）
  const start = html.indexOf('>', i) + 1;
  const re = /<(\/?)div\b/g;
  re.lastIndex = start;
  let depth = 1;
  let end = html.length;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  const chunk = html.slice(start, end);
  const text = chunk
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return text.slice(0, maxChars);
}

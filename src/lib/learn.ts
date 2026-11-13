import type { Decision } from '../types';

/**
 * 判定を一目で決めやすくするための「言葉の強調」。
 * - 決まった重要語（金額・ラウンド・上場・M&A など）は太字
 * - これまでの判定から学んだ言葉：「読む」「読了」によく出る言葉は緑、「不要」によく出る言葉は灰色
 * 学習は端末の中だけで行う（記事のタイトルの言葉を数えるだけ。費用はかからない）。
 */

export interface Token {
  text: string;
  start: number;
  end: number;
}

/** 意味のない言葉（数えない） */
const STOP = new Set([
  'お知らせ', 'について', 'に関する', 'のお知らせ', '株式会社', '開始', '発表', '提供', '開催', '実施', '決定', '公開', '販売', '発売', 'する', 'した', 'して', 'こと', 'ため', 'から', 'まで', 'より', 'など', 'および', 'また', 'ます', 'です', '年', '月', '日', '本日', '新た', '全国', '日本',
]);

interface Seg {
  segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
}
const SegCtor = (Intl as unknown as { Segmenter?: new (lang: string, o: { granularity: 'word' }) => Seg }).Segmenter;
const segmenter: Seg | null = SegCtor ? new SegCtor('ja', { granularity: 'word' }) : null;

/**
 * 言葉に分ける：漢字・カタカナ・英数字のまとまり（例：「資金調達」「クラウドファンディング」「estie」）と、
 * 隣り合う2つのまとまりの組み合わせ（例：「東証」＋「グロース」）。漢字のまとまりは単語にも分ける（「新規上場」→「新規」「上場」）。
 */
const RUN_RE = /[\p{sc=Han}々〆]+|[\p{sc=Katakana}ー]+|[A-Za-z][A-Za-z0-9&.+-]*|[Ａ-Ｚａ-ｚ][Ａ-Ｚａ-ｚ０-９]*/gu;
export function tokenize(text: string): Token[] {
  const runs: Token[] = [];
  for (const m of text.matchAll(RUN_RE)) runs.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  const out: Token[] = [];
  const add = (t: Token) => {
    if (t.text.length >= 2 && !STOP.has(t.text)) out.push(t);
  };
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    add(r);
    // 漢字のまとまりは単語にも分ける
    if (segmenter && /^[\p{sc=Han}々〆]{3,}$/u.test(r.text))
      for (const s of segmenter.segment(r.text))
        if (s.isWordLike && s.segment.length >= 2 && s.segment !== r.text) add({ text: s.segment, start: r.start + s.index, end: r.start + s.index + s.segment.length });
    const n = runs[i + 1];
    if (n && n.start === r.end && r.text.length + n.text.length <= 12) add({ text: r.text + n.text, start: r.start, end: n.end });
  }
  return out;
}

export interface LearnModel {
  /** 言葉ごとの傾き（＋：読む寄り、−：不要寄り）。目立つものだけ */
  terms: Map<string, number>;
  /** 会社ごとのこれまでの判定 */
  companies: Map<string, { keep: number; drop: number }>;
  /** 学習に使った判定の数 */
  n: number;
}

const MIN_COUNT = 3;
const MIN_SCORE = 0.9;
const tokenCache = new Map<string, string[]>();
const uniq = (title: string) => {
  let t = tokenCache.get(title);
  if (!t) {
    t = [...new Set(tokenize(title).map((x) => x.text.toLowerCase()))];
    tokenCache.set(title, t);
  }
  return t;
};

/** 1件ずつの操作（manual）の「読む・読了」と「不要」から学ぶ（まとめて不要・同じ発表は使わない） */
export function buildModel(decisions: Iterable<Decision>): LearnModel {
  const pos = new Map<string, number>();
  const neg = new Map<string, number>();
  const companies = new Map<string, { keep: number; drop: number }>();
  let P = 0;
  let N = 0;
  for (const d of decisions) {
    if (d.how !== 'manual' || !d.title) continue;
    const keep = d.status === 'keep' || d.status === 'done';
    if (!keep && d.status !== 'drop') continue;
    if (keep) P++;
    else N++;
    const m = keep ? pos : neg;
    for (const w of uniq(d.title)) m.set(w, (m.get(w) ?? 0) + 1);
    if (d.company) {
      const c = companies.get(d.company) ?? { keep: 0, drop: 0 };
      if (keep) c.keep++;
      else c.drop++;
      companies.set(d.company, c);
    }
  }
  const terms = new Map<string, number>();
  if (P >= 5 && N >= 5) {
    for (const w of new Set([...pos.keys(), ...neg.keys()])) {
      const p = pos.get(w) ?? 0;
      const q = neg.get(w) ?? 0;
      if (p + q < MIN_COUNT) continue;
      // 読む・不要それぞれの中での出やすさの比（なめらかにして、件数の偏りを打ち消す）
      const score = Math.log((p + 0.5) / (P + 1)) - Math.log((q + 0.5) / (N + 1));
      if (Math.abs(score) >= MIN_SCORE) terms.set(w, score);
    }
  }
  return { terms, companies, n: P + N };
}

/** 決まった重要語（金額・ラウンド・上場・M&A・資金調達・設立など） */
const KEY_RE =
  /[0-9０-９][0-9０-９,，.．]*\s*(?:億|万|千)?\s*(?:円|ドル|米ドル)|シリーズ\s?[A-ZＡ-Ｚ]|プレシリーズ\s?[A-ZＡ-Ｚ]?|シードラウンド|(?:東証|名証)?(?:グロース|プライム|スタンダード|ネクスト)市場|新規上場|上場承認|IPO|M&A|Ｍ＆Ａ|買収|子会社化|資本業務提携|資本提携|事業譲渡|経営統合|合併|TOB|公開買付|株式取得|資金調達|第三者割当(?:増資)?|新会社|設立|新規事業|参入/g;

export type Mark = 'key' | 'keep' | 'drop';
export interface Span {
  text: string;
  mark?: Mark;
}

/** 文を、強調する部分としない部分に分ける */
export function highlight(text: string, model: LearnModel | null): Span[] {
  const marks: (Mark | undefined)[] = new Array(text.length).fill(undefined);
  if (model?.terms.size) {
    for (const tk of tokenize(text)) {
      const s = model.terms.get(tk.text.toLowerCase());
      if (s === undefined) continue;
      for (let i = tk.start; i < tk.end; i++) if (!marks[i]) marks[i] = s > 0 ? 'keep' : 'drop';
    }
  }
  for (const m of text.matchAll(KEY_RE)) for (let i = m.index!; i < m.index! + m[0].length; i++) marks[i] = 'key';
  const out: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.mark === marks[i]) last.text += text[i];
    else out.push({ text: text[i], ...(marks[i] ? { mark: marks[i] } : {}) });
  }
  return out;
}

/** タイトルと会社から、これまでの判定に照らした傾き（＋：読む寄り） */
export function leaning(title: string, company: string, model: LearnModel | null): number {
  if (!model) return 0;
  let s = 0;
  for (const w of uniq(title)) s += model.terms.get(w) ?? 0;
  const c = model.companies.get(company);
  if (c && c.keep + c.drop >= 2) s += Math.log((c.keep + 0.5) / (c.drop + 0.5));
  return s;
}

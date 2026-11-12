import type { Item } from '../types';
import { bigrams, coreName, jaccard, normTitle } from './names';

/**
 * 同じ出来事を伝える別の記事（例：上場する会社と、出資しているVCの両方の発表）を探す。
 * 読み落としより誤ってまとめる方が困るので、条件は厳しめにする。
 * - 配信が前後36時間以内
 * - 相手のタイトルにこちらの会社名が出てくる（または逆）＋ 同じ注目テーマ（資金調達・上場・M&A）か、タイトルがある程度似ている
 * - または、会社は違ってもタイトルがほぼ同じ（共同リリースを両社が出している）。ただし次のタイトルはこの理由ではまとめない：
 *   ・資金調達・上場・M&A の発表（「新規上場承認に関するお知らせ」のような決まった言い回しを別々の会社が使うため）
 *   ・短いタイトル、同じ時間帯に3件以上ある決まり文句（「メディア関係者の方のみご覧頂けます」など）
 */
const WINDOW_MS = 36 * 3600e3;
const NAME_MIN = 3;
/** 会社名が短すぎる・ありふれた言葉で、ほかのタイトルにも出やすいもの */
const GENERIC = new Set(['日本', '東京', '大阪', 'japan', 'tokyo', 'グループ', 'ホールディングス', 'ジャパン', 'line']);
const STRONG = new Set(['fund', 'ipo', 'ma']);
/** タイトルが似ているだけでまとめるときの、タイトルの長さの下限（記号などを除いた文字数） */
const SIM_MIN_LEN = 20;

const coreOf = (c: string) => {
  const n = coreName(c);
  return n.length >= NAME_MIN && !GENERIC.has(n) ? n : '';
};

export function relatedItems(x: Item, pool: Iterable<Item>, limit = 5): Item[] {
  const xc = coreOf(x.company);
  const xt = normTitle(x.title);
  const xb = bigrams(xt);
  const xStrong = x.judge.tags.filter((t) => STRONG.has(t));
  const out: { it: Item; score: number }[] = [];
  const near: Item[] = [];
  for (const y of pool) if (y.id !== x.id && Math.abs(y.ts - x.ts) <= WINDOW_MS) near.push(y);
  // タイトルがほぼ同じだけでまとめてよいか
  const boiler = near.filter((y) => normTitle(y.title) === xt).length >= 2;
  const simOk = xStrong.length === 0 && xt.length >= SIM_MIN_LEN && !boiler;
  for (const y of near) {
    if (y.company && x.company && coreName(y.company) === coreName(x.company)) continue; // 同じ会社の別の発表はまとめない
    const yt = normTitle(y.title);
    const sim = jaccard(xb, bigrams(yt));
    const yc = coreOf(y.company);
    const mention = (xc && yt.includes(xc)) || (yc && xt.includes(yc));
    const sameTheme = xStrong.some((t) => y.judge.tags.includes(t));
    if ((mention && (sameTheme || sim >= 0.25)) || (simOk && sim >= 0.6 && !y.judge.tags.some((t) => STRONG.has(t))))
      out.push({ it: y, score: sim + (mention ? 0.5 : 0) });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((o) => o.it);
}

/** 会社名をそろえる（全角・半角、空白、記号、末尾の補足、法人格）。gBizINFO の名寄せ（functions/src/gbiz.ts）と同じ考え方 */
const LEGAL = /株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|npo法人|学校法人|医療法人|社会福祉法人|\(株\)|\(有\)/gi;

export function normName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]$/, '')
    .replace(/[\s・･.,，、。'’"”\-‐―]/g, '')
    .toLowerCase();
}

/** 法人格を除いた名前 */
export const coreName = (name: string): string => normName(name).replace(LEGAL, '');

/** タイトルを比べやすくする（全角・半角、空白、【】や「」の中の装飾を除く） */
export const normTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .replace(/【[^】]*】|\[[^\]]*\]|＼[^／]*／/g, '')
    .replace(/[\s・･.,，、。!！?？「」『』"“”'’〜~\-‐―:：|｜/／()（）]/g, '')
    .toLowerCase();

/** 2文字ずつの組の集合 */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 2つの集合の重なり（0〜1） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

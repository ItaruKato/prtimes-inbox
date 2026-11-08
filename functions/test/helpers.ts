import { ruleJudge } from '../src/judge';
import type { Article } from '../src/types';

/** 混む時間帯を想定した、長めの記事 */
export function bigArticle(i: number, hour = '2026110910', leadLen = 300): Article {
  const id = `${String(1000000 + i).padStart(9, '0')}.${String(10000 + (i % 5000)).padStart(9, '0')}`;
  const base = {
    id,
    url: `https://prtimes.jp/main/html/rd/p/${id}.html`,
    title: `株式会社テスト${i}がシリーズAラウンドで総額10億円の資金調達を実施、新たな事業領域への参入を加速し全国展開を目指す`,
    company: `株式会社テストホールディングス${i}`,
    companyId: String(10000 + (i % 5000)),
    publishedAt: `${hour.slice(0, 4)}-${hour.slice(4, 6)}-${hour.slice(6, 8)}T${hour.slice(8, 10)}:${String(i % 60).padStart(2, '0')}:00+09:00`,
    lead: 'あ'.repeat(leadLen),
    keywords: Array.from({ length: 12 }, (_, k) => `キーワード${k}`),
    ticker: '1234',
    section: '経営情報',
  };
  return { ...base, ai: ruleJudge(base), fetchedAt: '2026-11-09T01:05:00.000Z' };
}

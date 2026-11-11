import type { Article, TagKey } from '../types';

/**
 * 一覧用の「目次」（days/{YYYYMMDD-q}。6時間ごとに1ドキュメント）。
 * 一覧に出す項目だけを短い名前で持つので、記事本体（buckets）の 1/10 ほどの大きさで済む。
 * 本文の冒頭・要約・キーワードは、記事を開いたときに buckets から読む。
 * 取得処理（functions）と画面の両方で使う。
 */
export interface IndexEntry {
  /** タイトル */
  t: string;
  /** 会社名 */
  c: string;
  /** 配信日時（ISO） */
  p: string;
  /** タグ（判定済みのもの） */
  g?: TagKey[];
  /** キーワードに「ゲーム」を含む（新作ゲームの判定に使う） */
  k?: 1;
  /** Claude が新作ゲームと判定した */
  x?: 1;
  /** 要約がある */
  s?: 1;
  /** 証券コード */
  tk?: string;
}

const JST = 9 * 3600e3;
const p2 = (n: number) => String(n).padStart(2, '0');

/** 目次ドキュメントのID（JST の日付と、6時間ごとの区切り 0〜3） */
export function indexKey(publishedAt: string): string {
  const d = new Date(new Date(publishedAt).getTime() + JST);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${Math.floor(d.getUTCHours() / 6)}`;
}

export function toEntry(a: Article): IndexEntry {
  const e: IndexEntry = { t: a.title, c: a.company, p: a.publishedAt };
  const tags = a.ai?.tags ?? [];
  if (tags.length) e.g = tags;
  if ((a.keywords ?? []).some((k) => /ゲーム/.test(k))) e.k = 1;
  if (a.ai?.by?.startsWith('claude') && a.ai.autoExclude === '新作ゲーム') e.x = 1;
  if (a.ai?.summary) e.s = 1;
  if (a.ticker) e.tk = a.ticker;
  return e;
}

/** 目次から、一覧と自動除外の判定に足りるだけの記事を作る（本文の冒頭などは空） */
export function fromEntry(id: string, e: IndexEntry): Article {
  return {
    id,
    url: `https://prtimes.jp/main/html/rd/p/${id}.html`,
    title: e.t,
    company: e.c,
    publishedAt: e.p,
    lead: '',
    keywords: e.k ? ['ゲーム'] : [],
    ticker: e.tk ?? '',
    section: '',
    ai: {
      score: 'low',
      reason: '',
      tags: e.g ?? [],
      by: e.x ? 'claude-index' : 'index',
      ...(e.x ? { autoExclude: '新作ゲーム' } : {}),
      ...(e.s ? { summary: '' } : {}),
    },
  };
}

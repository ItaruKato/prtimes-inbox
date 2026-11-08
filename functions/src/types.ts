export type TagKey = 'fund' | 'ipo' | 'ma' | 'new' | 'mkt';
export type Score = 'high' | 'mid' | 'low';

export interface AiJudgement {
  score: Score;
  reason: string;
  tags: TagKey[];
  autoExclude?: string;
  summary?: string;
  /** 判定に使ったもの（例: rule-v0、claude-xxx） */
  by: string;
}

/** Firestore の buckets/{YYYYMMDDHH}.items.{id} に保存する記事 */
export interface Article {
  id: string;
  url: string;
  title: string;
  company: string;
  companyId: string;
  publishedAt: string;
  lead: string;
  keywords: string[];
  ticker: string;
  section: string;
  ai?: AiJudgement;
  fetchedAt: string;
}

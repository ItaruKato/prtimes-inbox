import type { AiStatus, Article, Decision, ExclusionConfig, Item, RuleReport } from '../types';

export interface Snapshot {
  items: Item[];
  decisions: Record<string, Decision>;
  /** 読み込んでいない「不要」の記事の数（setIncludeDropped(false) のとき） */
  hiddenDrops?: number;
}

/**
 * データの入出力。Firebase の設定があれば firestoreRepo、なければ試作データの mockRepo を使う。
 */
export interface Repo {
  /** 記事と振り分けを購読する（新着が来たら再通知される） */
  subscribe(onData: (s: Snapshot) => void, onError: (e: Error) => void): () => void;
  /** null は「振り分けを取り消す（AIの初期判定に戻す）」 */
  saveDecisions(changes: Record<string, Decision | null>): Promise<void>;
  /** AIの動作状況と今月の費用（本番のみ） */
  subscribeAiStatus?(onData: (s: AiStatus) => void): () => void;
  /** 自動除外ルールのオン・オフなどの設定 */
  subscribeConfig(onData: (c: ExclusionConfig) => void): () => void;
  saveConfig(c: ExclusionConfig): Promise<void>;
  /** 「不要」にした記事も読み込むか（ふだんは読み込まず、不要の一覧・検索・点検のときだけ読む） */
  setIncludeDropped?(on: boolean): void;
  /** 記事の全データ（本文の冒頭・要約など）。一覧が目次だけで動くときに、開いた記事の分だけ読む */
  loadArticle?(id: string, publishedAt: string): Promise<Article | null>;
  /** 除外ルールの週次集計（新しい週から最大8週） */
  subscribeRuleReports(onData: (r: RuleReport[]) => void): () => void;
}

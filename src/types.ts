/** PR TIMES から取得した記事（取得処理が保存する形） */
export interface Article {
  id: string; // 例: "000000036.000063034"（リリース番号.会社ID）
  url: string;
  title: string;
  company: string;
  publishedAt: string; // ISO 8601（+09:00）
  lead: string; // 本文冒頭
  keywords: string[];
  ticker: string; // 例: "TYO:8111"（上場企業のみ）
  section: string; // リリース種別（例: 経営情報、商品サービス）
  ai?: AiJudgement; // 本番では取得時にClaudeが付与
}

export type TagKey = 'fund' | 'ipo' | 'ma' | 'new' | 'mkt';
export type Score = 'high' | 'mid' | 'low';

/** AIの判定結果 */
export interface AiJudgement {
  score: Score;
  reason: string;
  tags: TagKey[];
  autoExclude?: string; // 例: "新作ゲーム"
  summary?: string;
  /** 要約の要点（例: 調達額 / 10億円） */
  points?: { label: string; value: string }[];
  /** 判定したもの（rule-v0: キーワードによる仮判定、claude-…: Claude） */
  by?: string;
}

/** 画面で使う記事（判定済み） */
export interface Item extends Article {
  ts: number;
  judge: AiJudgement;
  /** 当てはまる自動除外ルールの id（src/lib/exclusion.ts）。オンのルールが1つでもあれば「不要」に入る */
  rules: string[];
}

export type Status = 'inbox' | 'cand' | 'keep' | 'done' | 'drop';

/** ユーザーの振り分け操作。学習データにもなる */
export interface Decision {
  status: Status;
  /** manual: 1件ずつの操作 / bulk: まとめて不要（学習には弱めに反映） */
  how: 'manual' | 'bulk';
  at: number;
  /** 学習用：振り分けたときの記事タイトル・会社名・AIのおすすめ度 */
  title?: string;
  company?: string;
  aiScore?: Score;
  /** 不要にした理由（自由記入）。除外ルールを見直す材料にする */
  reason?: string;
  /** 不要にした理由（選択肢。src/lib/exclusion.ts の REASON_PRESETS） */
  reasonTags?: string[];
  /** 自動除外ルールに当てはまっていた記事か（受信箱に戻したら、そのルールの見直し材料） */
  ruleIds?: string[];
}

/** 画面の設定（Firestore の config/exclusion。端末をまたいで共有） */
export interface ExclusionConfig {
  /** オフにした自動除外ルールの id */
  disabledRules: string[];
}

/** AIの動作状況と費用（画面の左下に表示） */
export interface AiStatus {
  lastRunAt?: string;
  judged?: number;
  summarized?: number;
  backlog?: number;
  judgeErrors?: number;
  summaryErrors?: number;
  /** 今月の費用（米ドル） */
  monthUsd: number;
}

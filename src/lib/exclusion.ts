import type { Article } from '../types';
import { mockJudge } from './mockJudge';

/**
 * 自動で「不要」に入れるルール。
 * 不要にした理由（decisions の reason / reasonTags）と、ルールで除外した記事を受信箱に戻した記録をもとに、見直していく。
 * ルールを足すときは、id は変えない・使い回さない（オン・オフの設定が id で保存されるため）。
 */
export interface ExclusionRule {
  id: string;
  /** 画面に出す短い名前（「自動除外：○○」） */
  label: string;
  /** 何を除外するか */
  description: string;
  /** 追加・更新した日 */
  updated: string;
  test: (a: Article) => boolean;
}

/** 新作ゲームの案内か（Claude の過去の判定、またはキーワードによる判定） */
export const isGame = (a: Article): boolean =>
  (a.ai?.by?.startsWith('claude') === true && a.ai.autoExclude === '新作ゲーム') ||
  mockJudge(a).autoExclude === '新作ゲーム';

export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'game',
    label: '新作ゲーム',
    description: 'ゲームの新作・配信開始・事前登録・アップデート・コラボイベントの案内。ゲーム会社の資金調達・上場・M&Aは除外しない。',
    updated: '2026-11-09',
    test: isGame,
  },
];

export const ruleLabel = (id: string) => EXCLUSION_RULES.find((r) => r.id === id)?.label ?? id;

/** 記事に当てはまるルールの id（オン・オフに関係なく） */
export const matchRules = (a: Article): string[] => EXCLUSION_RULES.filter((r) => r.test(a)).map((r) => r.id);

/** 不要にした理由の選択肢（自由記入と組み合わせて使う） */
export const REASON_PRESETS = [
  'キャンペーン・セール',
  'イベント・セミナーの告知',
  '一般消費者向けの商品',
  '人事・受賞・採用',
  '分野が関係ない',
  '地域の話題',
  '情報が薄い',
] as const;

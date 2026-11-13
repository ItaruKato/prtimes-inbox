import type { Article } from '../types';
import { isGameArticle } from './mockJudge';

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
  (a.ai?.by?.startsWith('claude') === true && a.ai.autoExclude === '新作ゲーム') || isGameArticle(a);

/**
 * タイトルの正規表現で判定するルールを作る（毎日の見直しで足すルールは基本これを使う）。
 * except に当てはまる記事は除外しない（資金調達・M&A など、読みたい記事を巻き込まないため）。
 */
export function titleRule(r: {
  id: string;
  label: string;
  description: string;
  updated: string;
  include: RegExp;
  except?: RegExp;
}): ExclusionRule {
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    updated: r.updated,
    test: (a) => r.include.test(a.title) && !(r.except && r.except.test(a.title)),
  };
}

/** どのルールにも共通の例外：注目テーマに当たる記事は除外しない */
export const ALWAYS_KEEP = /資金調達|第三者割当|シリーズ[A-EＡ-Ｅ]|上場|IPO|M&A|Ｍ＆Ａ|買収|子会社化|経営統合|合併|資本業務提携|事業譲渡|TOB|公開買付/;

export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'game',
    label: '新作ゲーム',
    description: 'ゲームの新作・配信開始・事前登録・アップデート・コラボイベントの案内。ゲーム会社の資金調達・上場・M&Aは除外しない。',
    updated: '2026-11-09',
    test: isGame,
  },
  titleRule({
    id: 'anime',
    label: 'アニメ（消費者向け）',
    description:
      'TVアニメの放送・グッズ・コラボカフェ・声優・VTuber のイベントなど、消費者向けのアニメ関連。アニメ関連でも、資金調達・上場・M&A・提携・出資・事業・法人向け・ライセンス・マーケティング・調査などビジネスの話は除外しない。',
    updated: '2026-11-13',
    include: /アニメ|声優|劇場版|原画展|コラボカフェ|アニメイト|Vtuber|VTuber|ホロライブ|にじさんじ/,
    except: new RegExp(
      `${ALWAYS_KEEP.source}|業務提携|提携|出資|ファンド|事業|法人|BtoB|SaaS|海外展開|ライセンス|IPビジネス|AI|DX|制作会社|スタジオ設立|採用|研修|調査|レポート|決算|新会社|設立|マーケティング|広告代理|動画制作|営業`,
    ),
  }),
];

export const ruleLabel = (id: string) => EXCLUSION_RULES.find((r) => r.id === id)?.label ?? id;

/** 記事に当てはまるルールの id（オン・オフに関係なく） */
export const matchRules = (a: Article): string[] => EXCLUSION_RULES.filter((r) => r.test(a)).map((r) => r.id);

/** 不要にした理由の選択肢（自由記入と組み合わせて使う） */
/** 「読む」にした理由の選択肢（判定画面） */
export const KEEP_PRESETS = ['営業先の候補', '先行事例に使える', '業界が近い', '調達・上場・M&A', '競合・取引先の動き', 'トークのネタ'] as const;

export const REASON_PRESETS = [
  'キャンペーン・セール',
  'イベント・セミナーの告知',
  '一般消費者向けの商品',
  '人事・受賞・採用',
  '分野が関係ない',
  '地域の話題',
  '情報が薄い',
] as const;

import { describe, expect, it } from 'vitest';
import type { Article } from '../types';
import { EXCLUSION_RULES, matchRules } from './exclusion';

/**
 * 自動除外ルールのテスト。ルールを足したら、実際の記事タイトルで
 * 「除外する例」と「除外しない例（読みたい記事）」を必ず足すこと。
 */
const art = (title: string, extra: Partial<Article> = {}): Article => ({
  id: '000000001.000000001',
  url: 'https://prtimes.jp/main/html/rd/p/000000001.000000001.html',
  title,
  company: 'テスト株式会社',
  publishedAt: '2026-11-11T10:00:00+09:00',
  lead: '',
  keywords: [],
  ticker: '',
  section: '',
  ...extra,
});

/** ルール id → 除外する例・除外しない例 */
const CASES: Record<string, { drop: string[]; keep: string[] }> = {
  game: {
    drop: [
      '公式パズルゲーム『【推しの子】Puzzle Star』本日より新限定ピックアップガチャ[POP IN 2] 開催！',
      'HoYoverse新作『プチプラネット』Nintendo Switch™ 2版が2027年に登場！',
      '放置型アイドルRPG『STELLAR IDOL PROJECT』ちょっと早い 1.5th Anniversaryが開催中',
    ],
    keep: [
      '【ヴィ・ド・フランス】Nintendo Switch 2 などが当たるキャンペーン開催！',
      '【らーめんAFURI】ルミネ新宿店、開業10周年！公式グッズが当たる「AFURIガチャ」を開催',
      'ゲーム会社のA社、B社を買収',
      'シリーズAで5億円の資金調達を実施',
    ],
  },
  anime: {
    drop: [
      'TVアニメ『しろたん』10月3日（土）より放送開始！ 「メインビジュアル」解禁＆ファンミーティング開催決定',
      '漫画『天官賜福』コラボカフェ at 洒落CAFE 原作イラストを使用したオリジナルグッズ & メニュー',
      'にじさんじから「Welcome Goods」グッズが登場！2026年9月7日(月)18時から販売開始！',
      '人気声優の白井悠介さんや山谷祥生さんをMCにお迎えし、『アニメイトガールズフェスティバル』開催',
    ],
    keep: [
      'アニメ制作会社のA社、シリーズBで10億円の資金調達を実施',
      'アニメIPの海外ライセンス事業を開始',
      'アニメーション動画で営業資料を作るSaaSを提供開始',
      'VTuber事務所のB社をC社が子会社化',
      'アニメ視聴者1,000人の意識調査レポートを公開',
    ],
  },
  'sports-match': {
    drop: [
      'ノジマＴリーグ 2026-2027 公式戦 9月5日開催 九州カリーナ vs 木下アビエル神奈川 試合結果',
      '【試合結果】9月5日(土) vs 茨城ロボッツ (プレシーズンマッチ)',
      '【第42回全国選抜フットサル大会】組合せおよび試合スケジュール公開のお知らせ',
      '【シーホース三河】2026-27シーズン ホームゲームにおける応援ガイドについて',
      '9月20日（日） アジアリーグアイスホッケー 2026-2027 「TKC 創業60周年記念マッチデー」を開催',
    ],
    keep: [
      'steer株式会社、川崎ブレイブサンダースの2026-27シーズンオフィシャルスポンサーに就任〜10月24日（土）東急ドレッセとどろきアリーナで冠試合開催〜',
      '埼玉県川越市からJリーグを目指す「COEDO KAWAGOE F.C」、株式会社treeと2026シーズンのブロンズパートナー契約を締結',
      '男子プロバスケットボールリーグ（B.LEAGUE）の試合データ、Snowflakeで無償公開',
      'ライブ・スポーツ観戦の行き帰りをシェア乗りで結ぶイベント特化型予約サイトをオープン',
      'プロ野球球団のA社、シリーズBで10億円の資金調達を実施',
      '「資金調達伴走支援プログラム」採択4事業者のキックオフイベントを開催しました',
    ],
  },
};

describe('自動除外ルール', () => {
  it('すべてのルールにテストの例がある', () => {
    for (const r of EXCLUSION_RULES) expect(CASES[r.id], `ルール ${r.id} の例を CASES に足してください`).toBeTruthy();
  });
  it('id が重複していない', () => {
    const ids = EXCLUSION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  for (const [id, c] of Object.entries(CASES)) {
    describe(id, () => {
      for (const t of c.drop) it(`除外する: ${t}`, () => expect(matchRules(art(t))).toContain(id));
      for (const t of c.keep) it(`除外しない: ${t}`, () => expect(matchRules(art(t))).not.toContain(id));
    });
  }
});

import { mockJudge } from './mockJudge';
import { isGameArticle } from './mockJudge';
describe('isGameArticle は mockJudge の新作ゲーム判定と同じ', () => {
  const titles = [
    ...Object.values(CASES).flatMap((c) => [...c.drop, ...c.keep]),
    '新作RPG、事前登録を開始',
    'シリーズAで資金調達、ゲームアプリ開発を加速',
    'PS5版の発売日が決定',
    'Switch 2 が当たるキャンペーン',
  ];
  for (const t of titles)
    for (const kw of [[], ['ゲーム']])
      it(`${t} / ${kw.join()}`, () => {
        const a = art(t, { keywords: kw });
        expect(isGameArticle(a)).toBe(mockJudge(a).autoExclude === '新作ゲーム');
      });
});

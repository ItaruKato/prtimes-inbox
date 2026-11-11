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

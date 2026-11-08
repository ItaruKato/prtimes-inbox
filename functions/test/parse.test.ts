import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bucketKey, companyIdOf, mergeRaw, parseArticlePage, parseNewsSitemap, parseRss } from '../src/parse';
import { ruleJudge } from '../src/judge';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

describe('parse', () => {
  it('RSS から会社名・日時・本文冒頭を取る', () => {
    const items = parseRss(fx('index.rdf'));
    expect(items.length).toBeGreaterThan(150);
    const a = items[0];
    expect(a.id).toMatch(/^\d+\.\d+$/);
    expect(a.company).toBeTruthy();
    expect(a.publishedAt).toMatch(/\+09:00$/);
    expect(a.lead).not.toMatch(/^\[/);
  });

  it('サイトマップからキーワードと証券コードを取る', () => {
    const items = parseNewsSitemap(fx('sitemap-news.xml'));
    expect(items.length).toBeGreaterThan(50);
    expect(items[0].keywords!.length).toBeGreaterThan(0);
    expect(items.some((i) => i.ticker)).toBe(true);
  });

  it('記事ページから会社名とリリース種別を取る', () => {
    expect(parseArticlePage(fx('article.html'))).toEqual({ company: '株式会社ドズル', section: '商品サービス' });
  });

  it('RSS とサイトマップを統合する', () => {
    const m = mergeRaw(parseRss(fx('index.rdf')), parseNewsSitemap(fx('sitemap-news.xml')));
    expect(m.size).toBeGreaterThan(250);
  });

  it('会社IDと時間バケット（JST）', () => {
    expect(companyIdOf('000000036.000063034')).toBe('63034');
    expect(bucketKey('2026-11-08T20:10:02+09:00')).toBe('2026110820');
    expect(bucketKey('2026-11-08T00:05:00+09:00')).toBe('2026110800');
  });

  it('ルール判定', () => {
    const base = { lead: '', keywords: [], ticker: '', section: '' };
    expect(ruleJudge({ ...base, title: 'シリーズAで5億円の資金調達を実施' }).score).toBe('high');
    expect(ruleJudge({ ...base, title: '新作RPG、事前登録を開始' }).autoExclude).toBe('新作ゲーム');
    expect(ruleJudge({ ...base, title: '非上場株式のセミナー開催' }).tags).not.toContain('ipo');
  });
});

import { parseNewArrival } from '../src/backfill';
describe('parseNewArrival', () => {
  it('一覧から記事40件と次のカーソルを取る', () => {
    const { items, next } = parseNewArrival(fx('newarrival.html'));
    expect(items.length).toBe(40);
    expect(next).toMatch(/^\d+_\d+$/);
    const a = items[0];
    expect(a.id).toMatch(/^\d+\.\d+$/);
    expect(a.publishedAt).toMatch(/\+09:00$/);
    expect(a.company).toBeTruthy();
    expect(a.title).not.toMatch(/\.\.\.$/);
    expect(new Date(a.publishedAt).getTime()).toBeGreaterThan(new Date(items[39].publishedAt).getTime() - 1);
  });
});

describe('新作ゲームの判定（キーワード）', () => {
  const base = { lead: '', keywords: [] as string[], ticker: '', section: '' };
  const game = (title: string) => ruleJudge({ ...base, title }).autoExclude === '新作ゲーム';
  it('ゲームの案内は除外する', () => {
    expect(game('公式パズルゲーム『【推しの子】Puzzle Star』本日より新限定ピックアップガチャ[POP IN 2] 開催！')).toBe(true);
    expect(game('HoYoverse新作『プチプラネット』Nintendo Switch™ 2版が2027年に登場！')).toBe(true);
    expect(game('放置型アイドルRPG『STELLAR IDOL PROJECT』ちょっと早い 1.5th Anniversaryが開催中')).toBe(true);
    expect(game('2026年11月2日（月）15:00 正式サービス開始！オンライン対戦ボードゲームアプリ『GALAST』')).toBe(true);
    expect(game('新作RPG、事前登録を開始')).toBe(true);
  });
  it('ゲーム以外の記事は除外しない', () => {
    expect(game('【ヴィ・ド・フランス】Nintendo Switch 2 などが当たるキャンペーン開催！クリスマス予約が11/1(日)より')).toBe(false);
    expect(game('【らーめんAFURI】ルミネ新宿店、開業10周年！らーめん無料券や公式グッズが当たる「AFURIガチャ」を開催')).toBe(false);
    expect(game('美容医療業界初！来場者数5,000人規模の美容クリニックイベントに高さ2.0mの巨大ガチャ「モンスター」登場')).toBe(false);
    expect(game('シリーズAで5億円の資金調達を実施')).toBe(false);
    expect(game('ゲーム会社のA社、B社を買収')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Item } from '../types';
import { relatedItems } from './sameEvent';
import { coreName } from './names';

const mk = (id: string, title: string, company: string, hoursAgo: number, tags: Item['judge']['tags'] = []): Item =>
  ({
    id,
    url: '',
    title,
    company,
    publishedAt: '',
    lead: '',
    keywords: [],
    ticker: '',
    section: '',
    ts: Date.UTC(2026, 10, 12) - hoursAgo * 3600e3,
    judge: { score: 'low', reason: '', tags },
    rules: [],
  }) as Item;

describe('同じ発表', () => {
  const ipo = mk('1.1', '東京証券取引所グロース市場への新規上場に関するお知らせ', '株式会社estie(エスティ)', 0, ['ipo']);
  const vc = mk('2.2', 'グローバル・ブレインの投資先である株式会社estie、東証グロース市場へ新規上場', 'グローバル・ブレイン株式会社', 2, ['ipo']);
  const other = mk('3.3', 'グローバル・ブレインの投資先である株式会社RECEPTIONIST、東証グロース市場へ新規上場', 'グローバル・ブレイン株式会社', 2, ['ipo']);
  const joint1 = mk('4.4', '期間限定トッピング「逆襲の赤ウインナー」を2026年11月16日より発売', '株式会社ファイブグループ', 1);
  const joint2 = mk('5.5', '期間限定トッピング「逆襲の赤ウインナー」を2026年11月16日より発売', '株式会社パンチョ', 1);
  const ipoA = mk('7.7', '東京証券取引所グロース市場への新規上場承認に関するお知らせ', 'スマートニュース株式会社', 3, ['ipo']);
  const ipoB = mk('8.8', '東京証券取引所グロース市場への新規上場承認に関するお知らせ', '株式会社FOLIOホールディングス', 3, ['ipo']);
  const media = ['10.1', '10.2', '10.3'].map((id, i) => mk(id, 'メディア関係者の方のみご覧頂けます', `会社${i}株式会社`, 1));
  const old = mk('6.6', 'グローバル・ブレインの投資先である株式会社estie、東証グロース市場へ新規上場', 'グローバル・ブレイン株式会社', 80, ['ipo']);
  const pool = [ipo, vc, other, joint1, joint2, old, ipoA, ipoB, ...media];

  it('会社名が出てくる同じテーマの記事をまとめる', () => {
    expect(relatedItems(ipo, pool).map((x) => x.id)).toEqual(['2.2']);
    expect(relatedItems(vc, pool).map((x) => x.id)).toContain('1.1');
  });
  it('共同リリース（タイトルがほぼ同じ）をまとめる', () => {
    expect(relatedItems(joint1, pool).map((x) => x.id)).toEqual(['5.5']);
  });
  it('決まった言い回しの上場の発表・決まり文句のタイトルはまとめない', () => {
    expect(relatedItems(ipoA, pool).map((x) => x.id)).not.toContain('8.8');
    expect(relatedItems(media[0], pool)).toEqual([]);
  });
  it('別の会社の話・同じ会社の別の発表・日付が離れた記事はまとめない', () => {
    expect(relatedItems(other, pool).map((x) => x.id)).not.toContain('1.1');
    expect(relatedItems(vc, pool).map((x) => x.id)).not.toContain('3.3');
    expect(relatedItems(ipo, pool).map((x) => x.id)).not.toContain('6.6');
  });
  it('名前をそろえる', () => {
    expect(coreName('株式会社estie(エスティ)')).toBe('estie');
  });
});

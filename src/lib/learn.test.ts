import { describe, expect, it } from 'vitest';
import type { Decision } from '../types';
import { buildModel, highlight, leaning, tokenize } from './learn';

const d = (title: string, status: Decision['status'], company = 'A社', how: Decision['how'] = 'manual'): Decision => ({ status, how, at: 0, title, company });

describe('言葉の強調と学習', () => {
  it('言葉に分ける（2語の組み合わせも）', () => {
    const t = tokenize('東証グロース市場へ新規上場').map((x) => x.text);
    expect(t).toContain('新規上場');
    expect(t).toContain('グロース');
    expect(tokenize('クラウドファンディング開始').map((x) => x.text)).toContain('クラウドファンディング');
    expect(tokenize('東証グロース市場').map((x) => x.text)).toContain('東証グロース');
  });

  it('読む・不要によく出る言葉を覚える', () => {
    const decs: Decision[] = [
      ...['シリーズAで資金調達', 'シリーズBで資金調達を実施', 'プレシリーズAの資金調達', '資金調達と事業拡大', '資金調達で採用強化', 'シードで資金調達'].map((t) => d(t, 'keep')),
      ...['クラウドファンディング開始', 'クラウドファンディングで支援募集', 'クラウドファンディング挑戦', '新商品を発売', '冬の新商品', '限定新商品'].map((t) => d(t, 'drop', 'B社')),
      d('クラウドファンディング', 'drop', 'C社', 'bulk'),
    ];
    const m = buildModel(decs);
    expect(m.terms.get('資金調達')!).toBeGreaterThan(0);
    expect(m.terms.get('クラウドファンディング')!).toBeLessThan(0);
    expect(m.companies.get('B社')).toEqual({ keep: 0, drop: 6 });
    expect(m.n).toBe(12);
    expect(leaning('C社がクラウドファンディング開始', 'B社', m)).toBeLessThan(0);
    expect(leaning('D社が資金調達', 'X社', m)).toBeGreaterThan(0);

    const spans = highlight('A社がクラウドファンディングで5億円を調達', m);
    expect(spans.find((s) => s.text === 'クラウドファンディング')?.mark).toBe('drop');
    expect(spans.find((s) => s.text.includes('5億円'))?.mark).toBe('key');
  });

  it('判定が少ないうちは学んだ言葉を出さない（決まった重要語だけ）', () => {
    const m = buildModel([d('資金調達', 'keep'), d('新商品', 'drop')]);
    expect(m.terms.size).toBe(0);
    expect(highlight('シリーズAで10億円', m).filter((s) => s.mark === 'key').map((s) => s.text)).toEqual(['シリーズA', '10億円']);
  });
});

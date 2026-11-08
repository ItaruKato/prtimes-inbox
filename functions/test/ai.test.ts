import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { examplesText, judgeArticles, JUDGE_MODEL } from '../src/ai';
import { extractBody } from '../src/parse';
import type { Article } from '../src/types';

const art = (id: string, title: string): Article => ({
  id, url: `https://prtimes.jp/main/html/rd/p/${id}.html`, title, company: 'テスト株式会社', companyId: '1',
  publishedAt: '2026-11-09T10:00:00+09:00', lead: '', keywords: [], ticker: '', section: '', fetchedAt: '',
});

describe('examplesText', () => {
  it('見落とし・過大評価に注記を付ける', () => {
    const t = examplesText([
      { title: 'A社が資金調達', company: 'A社', label: 'read', aiScore: 'mid' },
      { title: 'B社のセール', company: 'B社', label: 'drop', aiScore: 'high' },
    ]);
    expect(t).toContain('A社が資金調達（A社）（AIは見落としていた）');
    expect(t).toContain('B社のセール（B社）（AIは高にしていたが不要だった）');
  });
  it('履歴がなければ空', () => expect(examplesText([])).toBe(''));
});

describe('judgeArticles', () => {
  it('結果を記事IDに対応づけ、除外は low にする', async () => {
    const parse = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      parsed_output: {
        results: [
          { id: '1.1', score: 'high', tags: ['fund'], reason: '資金調達', exclude: '' },
          { id: '2.1', score: 'mid', tags: [], reason: 'ゲーム', exclude: '新作ゲーム' },
          { id: '9.9', score: 'high', tags: [], reason: '知らないID', exclude: '' },
        ],
      },
    });
    const client = { messages: { parse } } as unknown as Anthropic;
    const { results, usage } = await judgeArticles(client, [art('1.1', '資金調達'), art('2.1', '新作RPG')], []);
    expect(results.get('1.1')).toMatchObject({ score: 'high', tags: ['fund'], by: JUDGE_MODEL });
    expect(results.get('2.1')).toMatchObject({ score: 'low', autoExclude: '新作ゲーム' });
    expect(results.has('9.9')).toBe(false);
    expect(usage.input).toBe(100);
    const req = parse.mock.calls[0][0];
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.thinking).toEqual({ type: 'disabled' });
  });
  it('拒否されたら何も返さない', async () => {
    const client = { messages: { parse: vi.fn().mockResolvedValue({ stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 }, parsed_output: null }) } } as unknown as Anthropic;
    const { results } = await judgeArticles(client, [art('1.1', 'x')], []);
    expect(results.size).toBe(0);
  });
});

describe('extractBody', () => {
  it('本文だけを取り出す', () => {
    const t = extractBody(readFileSync(new URL('./fixtures/article-full.html', import.meta.url), 'utf8'));
    expect(t.startsWith('ゲーム実況に特化したクリエイター事務所')).toBe(true);
    expect(t).not.toContain('<');
    expect(t).not.toContain('メディア関係者向け');
    expect(t.length).toBeGreaterThan(200);
  });
});

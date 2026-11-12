import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Firestore } from 'firebase-admin/firestore';
import { classifyIndustry, INDUSTRY_SYSTEM, INDUSTRY_TAGS, industryInput, tidyIndustry } from '../src/industry';

describe('industry', () => {
  it('分類の表：コードが重ならず、説明に全部入っている', () => {
    const codes = INDUSTRY_TAGS.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(46);
    for (const t of INDUSTRY_TAGS) expect(INDUSTRY_SYSTEM).toContain(`- ${t.code}: ${t.label}`);
  });

  it('AI に渡す材料：見出しは新しい順に30件まで', () => {
    const a = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x.${i}`, { t: `見出し${i}`, p: `2026-${String((i % 12) + 1).padStart(2, '0')}-01T10:00:00+09:00` }]));
    const s = industryInput(
      { name: 'テスト', profile: { industry: '情報通信' }, gbiz: { name: '株式会社テスト', summary: '勤怠管理クラウドの開発', businessItems: ['ソフトウェア'] } },
      a,
    );
    expect(s).toContain('会社名: テスト');
    expect(s).toContain('正式な名前: 株式会社テスト');
    expect(s).toContain('PR TIMES の業種: 情報通信');
    expect(s).toContain('事業の概要（gBizINFO）: 勤怠管理クラウドの開発');
    expect(s).toContain('（新しい順、30件）');
    expect(s.split('\n').filter((l) => l.startsWith('- ')).length).toBe(30);
    expect(s.indexOf('2026-12-01')).toBeLessThan(s.indexOf('2026-05-01'));
    expect(s).not.toContain('2026-01-01'); // 古い10件は入らない
    // 材料が少ない会社
    expect(industryInput({ name: 'B' }, undefined)).toBe('会社名: B\nプレスリリースの見出し（新しい順、0件）:');
  });

  it('答えを整える：サブは2つまで・main と重ならない', () => {
    expect(tidyIndustry({ main: 'saas', subs: ['saas', 'ai', 'ai', 'hr', 'si'], biz: 'btob', confidence: 'high', reason: ' 理由 ' })).toEqual({
      main: 'saas',
      subs: ['ai', 'hr'],
      biz: 'btob',
      confidence: 'high',
      reason: '理由',
    });
  });

  it('AI を呼ぶ：選んだ AI の名前で呼び、使った量を記録する。断られたら失敗にする', async () => {
    const parse = vi.fn().mockResolvedValue({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 700 },
      parsed_output: { main: 'saas', subs: [], biz: 'btob', confidence: 'high', reason: '法人向けクラウド' },
    });
    const set = vi.fn().mockResolvedValue(undefined);
    const db = { collection: () => ({ doc: () => ({ set }) }) } as unknown as Firestore;
    const r = await classifyIndustry({ beta: { messages: { parse } } } as unknown as Anthropic, db, 'sonnet', '会社名: A');
    expect(parse.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
    expect(parse.mock.calls[0][0].fallbacks).toBeUndefined();
    expect(r).toMatchObject({ main: 'saas', subs: [], biz: 'btob', model: 'claude-sonnet-5-5', v: 1 });
    expect(set).toHaveBeenCalled();
    const refused = vi.fn().mockResolvedValue({ stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 }, parsed_output: null });
    await expect(classifyIndustry({ beta: { messages: { parse: refused } } } as unknown as Anthropic, db, 'haiku', 'x')).rejects.toThrow('決められません');
  });
});

import { describe, expect, it } from 'vitest';
import { companyIdOf, toFacts } from './companyInfo';

describe('会社の情報', () => {
  it('台帳と会社ごとの記事から作る', () => {
    const now = Date.UTC(2026, 10, 12);
    const f = toFacts(
      {
        profile: { industry: '情報通信', address: '東京都渋谷区代々木1-1', capital: '800万円', listed: '未上場', established: '2017年01月' },
        gbiz: { employees: 25, capital: 150000000, established: '2016-12-01' },
      },
      {
        a: {
          '1.9': { t: 'A社、シリーズAで5億円を調達', p: '2026-06-01T10:00:00+09:00' },
          '2.9': { t: 'A社、B社を子会社化', p: '2026-09-01T10:00:00+09:00' },
          '3.9': { t: '新サービス開始', p: '2026-10-01T10:00:00+09:00' },
          '4.9': { t: '資金調達のお知らせ', p: '2025-01-01T10:00:00+09:00' },
        },
      },
      now,
    );
    expect(f).toEqual({
      industry: '情報通信',
      area: '東京都渋谷区',
      employees: '従業員 25人',
      capital: '1.5億円',
      established: '2016年設立',
      listed: '未上場',
      url: undefined,
      year: 3,
      fund: 1,
      ipo: 0,
      ma: 1,
      lastStrong: { kind: 'M&A', date: '2026/09' },
    });
    expect(companyIdOf('000000036.000063034')).toBe('63034');
    expect(toFacts(undefined, undefined)).toBeNull();
  });
});

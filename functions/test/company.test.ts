import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCompanyProfile, resumeArchive } from '../src/company';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

describe('company', () => {
  it('記事ページの「企業情報」を読む', () => {
    expect(parseCompanyProfile(fx('company-info.html'))).toEqual({
      url: 'https://kokenawa.co.jp/',
      industry: '情報通信',
      address: '愛知県清須市西枇杷島町芳野１丁目３２',
      phone: '052-990-2752',
      representative: '苔縄義宗',
      listed: '未上場',
      capital: '800万円',
      established: '2017年01月',
    });
  });

  it('企業情報がないページは null', () => {
    expect(parseCompanyProfile(fx('article.html'))).toBeNull();
  });
});

describe('resumeArchive', () => {
  const OLD = '2025-11-01T00:00:00+09:00';
  const NEW = '2025-01-01T00:00:00+09:00';
  it('さかのぼる日が同じなら、そのまま続ける', () => {
    const prev = { from: NEW, day: '2026-06-18', cursor: '1781744402_3523791', pages: 10 };
    expect(resumeArchive(prev, NEW, '2026-11-12')).toEqual(prev);
  });
  it('早めたときは、読みかけの日から続ける（今日から読み直さない）', () => {
    const prev = { from: OLD, day: '2026-06-18', cursor: '1781744402_3523791', dayPages: 42, pages: 5483, items: 216268 };
    expect(resumeArchive(prev, NEW, '2026-11-12')).toEqual({ ...prev, from: NEW });
  });
  it('読み終えていたら、前のさかのぼる日の前の日から続ける', () => {
    const prev = { from: OLD, day: '2025-11-01', done: true, cursor: null, pages: 9000 };
    expect(resumeArchive(prev, NEW, '2026-11-12')).toEqual({ from: NEW, day: '2025-10-31', done: false, cursor: null, dayPages: 0, pages: 9000 });
  });
  it('はじめて、または遅らせたときは今日から', () => {
    expect(resumeArchive({}, NEW, '2026-11-12')).toEqual({ from: NEW, day: '2026-11-12' });
    expect(resumeArchive({ from: NEW, day: '2026-01-01' }, OLD, '2026-11-12')).toEqual({ from: OLD, day: '2026-11-12' });
  });
});

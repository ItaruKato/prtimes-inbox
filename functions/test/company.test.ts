import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCompanyProfile } from '../src/company';

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

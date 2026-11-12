import { describe, expect, it } from 'vitest';
import { coreName, GBIZ_BASE, lookupExtra, normName, pickCandidate, prefCode, toGbizExtra, toGbizInfo, toMoney } from '../src/gbiz';

describe('gbiz', () => {
  it('名前をそろえる', () => {
    expect(normName('株式会社ＭＵＳＥ')).toBe(normName('株式会社MUSE'));
    expect(normName('LINEヤフー株式会社（LINE GAME）')).toBe('lineヤフー株式会社');
    expect(coreName('株式会社 ブーストキャピタル')).toBe('ブーストキャピタル');
    expect(coreName('（株）テスト')).toBe('テスト');
    expect(coreName('一般社団法人AX認定協会')).toBe('ax認定協会');
  });

  it('所在地から都道府県コード', () => {
    expect(prefCode('東京都渋谷区代々木1-55-2')).toBe('13');
    expect(prefCode('〒100-0001 北海道札幌市')).toBe('01');
    expect(prefCode('愛知県清須市西枇杷島町')).toBe('23');
    expect(prefCode('Singapore')).toBeNull();
    expect(prefCode(undefined)).toBeNull();
  });

  it('同じ会社を1つ選ぶ（決まらなければ選ばない）', () => {
    const list = [
      { corporate_number: '1', name: '株式会社ＭＵＳＥ', location: '東京都港区南青山1-1' },
      { corporate_number: '2', name: '株式会社MUSEホールディングス', location: '東京都港区' },
      { corporate_number: '3', name: '合同会社MUSE', location: '大阪府大阪市北区' },
    ];
    expect(pickCandidate('株式会社MUSE', '東京都港区南青山2-2', list)).toMatchObject({ c: { corporate_number: '1' }, how: 'name' });
    // 法人格の表記が違っても、法人格を除いた名前が1つだけ一致すれば選ぶ
    expect(pickCandidate('MUSE株式会社', '東京都港区', list.slice(0, 2))).toMatchObject({ c: { corporate_number: '1' }, how: 'core' });
    // 同名が2社：所在地で絞る
    const two = [
      { corporate_number: '4', name: '株式会社テスト', location: '東京都新宿区西新宿1' },
      { corporate_number: '5', name: '株式会社テスト', location: '東京都渋谷区道玄坂1' },
    ];
    expect(pickCandidate('株式会社テスト', '東京都渋谷区道玄坂2-3', two)).toMatchObject({ c: { corporate_number: '5' }, how: 'name+address' });
    expect(pickCandidate('株式会社テスト', '東京都港区', two)).toEqual({ c: null, how: 'ambiguous' });
    expect(pickCandidate('株式会社まったく別', '東京都', list)).toEqual({ c: null, how: 'none' });
  });

  it('詳細を台帳の形にする', () => {
    expect(
      toGbizInfo({ corporate_number: '1234567890123', name: '株式会社A', representative_name: '山田 太郎', capital_stock: 10000000, employee_number: '25', company_url: '', business_summary: 'SaaS' }),
    ).toEqual({ corporateNumber: '1234567890123', name: '株式会社A', representative: '山田 太郎', capital: 10000000, employees: 25, summary: 'SaaS' });
  });

  it('金額を円に直す（単位が分からなければ直さない）', () => {
    expect(toMoney('12,607,858', '百万円')).toEqual({ raw: '12,607,858', unit: '百万円', yen: 12607858e6 });
    expect(toMoney('△1,200', '千円')).toEqual({ raw: '△1,200', unit: '千円', yen: -1200e3 });
    expect(toMoney(5000000, 'JPY')).toEqual({ raw: '5000000', unit: 'JPY', yen: 5000000 });
    expect(toMoney('300', 'USD')).toEqual({ raw: '300', unit: 'USD' });
    expect(toMoney('N/A', '百万円')).toBeUndefined();
    expect(toMoney('', '百万円')).toBeUndefined();
  });

  it('厚生年金の加入者数（全喪した事業所を除いて合計）と、最新の回の財務', () => {
    const corp = [
      { corporation_name: '本社', insured_number: '1,200', 'meta-data': { last_update_date: '2026-07-01' } },
      { corporation_name: '大阪支店', insured_number: '35人' },
      { corporation_name: '旧工場', insured_number: '80', loss_date: '2024-03-31' },
      { corporation_name: '不明', insured_number: '' },
    ];
    const finance = {
      fiscal_year_cover_page: '2025年4月1日～2026年3月31日',
      management_index: [
        { period: '第86期', net_sales_summary_of_business_results: '900', net_sales_summary_of_business_results_unit_ref: '百万円' },
        {
          period: '第87期',
          net_sales_summary_of_business_results: '1,000',
          net_sales_summary_of_business_results_unit_ref: '百万円',
          net_assets_summary_of_business_results: 'N/A',
          total_assets_summary_of_business_results: '2,500',
          total_assets_summary_of_business_results_unit_ref: '百万円',
          number_of_employees: '1,234',
        },
      ],
    };
    expect(toGbizExtra(corp, finance)).toEqual({
      insured: { total: 1235, offices: 2, updated: '2026-07-01' },
      finance: {
        year: '2025年4月1日～2026年3月31日',
        period: '第87期',
        sales: { raw: '1,000', unit: '百万円', yen: 1000e6 },
        totalAssets: { raw: '2,500', unit: '百万円', yen: 2500e6 },
        employees: 1234,
      },
    });
    // 何も無ければ空
    expect(toGbizExtra(undefined, undefined)).toEqual({});
    expect(toGbizExtra([], { management_index: [{ period: '第1期' }] })).toEqual({});
  });

  it('詳細に加入者数・財務が無ければ、事業所情報・財務情報を読みに行く', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      if (url.endsWith('/corporation')) return { 'hojin-infos': [{ 'corporation-info': [{ insured_number: '12' }] }] };
      if (url.endsWith('/finance')) return { 'hojin-infos': [{}] };
      return {};
    };
    const sleep = async () => {};
    expect(await lookupExtra(get, sleep, '1234567890123', { name: '株式会社A' })).toEqual({ insured: { total: 12, offices: 1 } });
    expect(urls).toEqual([`${GBIZ_BASE}/1234567890123/corporation`, `${GBIZ_BASE}/1234567890123/finance`]);
    // 詳細に入っていれば読みに行かない
    urls.length = 0;
    expect(await lookupExtra(get, sleep, '1234567890123', { 'corporation-info': [{ insured_number: '3' }], finance: {} })).toEqual({
      insured: { total: 3, offices: 1 },
    });
    expect(urls).toEqual([]);
  });
});

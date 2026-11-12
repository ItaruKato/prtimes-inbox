import { describe, expect, it } from 'vitest';
import { coreName, normName, pickCandidate, prefCode, toGbizInfo } from '../src/gbiz';

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
});

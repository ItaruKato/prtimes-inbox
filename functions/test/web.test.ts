import { describe, expect, it } from 'vitest';
import { htmlText, looksLikeCompany, pickLinks, robotsAllows, safeUrl, tidyWeb } from '../src/web';

describe('会社 HP の読み込み', () => {
  it('普通のサイトだけを読む（社内のサーバー・IP・変なポートは読まない）', () => {
    expect(safeUrl('www.example.co.jp')?.toString()).toBe('https://www.example.co.jp/');
    expect(safeUrl('http://example.com/about')?.pathname).toBe('/about');
    for (const bad of ['http://169.254.169.254/', 'http://metadata.google.internal/', 'http://localhost/', 'https://10.0.0.1', 'ftp://example.com', 'https://example.com:8080/', 'https://user:pw@example.com', 'intranet'])
      expect(safeUrl(bad)).toBeNull();
  });
  it('robots.txt を守る（長く一致するルールを優先）', () => {
    const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: BadBot\nDisallow: /';
    expect(robotsAllows(txt, '/company')).toBe(true);
    expect(robotsAllows(txt, '/private/x')).toBe(false);
    expect(robotsAllows(txt, '/private/ok/page')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /', '/')).toBe(false);
    expect(robotsAllows('', '/')).toBe(true);
  });
  it('HTML を文字に（表は「｜」でつなぐ、スクリプトは捨てる）', () => {
    expect(htmlText('<script>x()</script><table><tr><th>資本金</th><td>1億円</td></tr></table><p>A&amp;B</p>')).toBe('資本金｜1億円｜\nA&B');
  });
  it('同じサイトの会社概要などへのリンクを選ぶ', () => {
    const html = '<a href="/company/outline.html">会社概要</a><a href="https://other.com/about">外</a><a href="/news">ニュース</a><a href="/recruit">採用</a><a href="/about">私たちについて</a><a href="/x.pdf">会社案内PDF</a>';
    expect(pickLinks(html, new URL('https://www.example.co.jp/'))).toEqual(['https://www.example.co.jp/company/outline.html', 'https://www.example.co.jp/about']);
  });
  it('その会社のページらしいか（法人格を除いた名前）', () => {
    expect(looksLikeCompany('株式会社テスト商事', [{ url: 'u', title: 'テスト商事｜トップ', text: '' }])).toBe(true);
    expect(looksLikeCompany('株式会社テスト商事', [{ url: 'u', title: '別の会社', text: '' }])).toBe(false);
  });
  it('出どころが読んだページにない項目と、会社のサイトでないときは捨てる', () => {
    const item = (value: string, source: string) => ({ value, asOf: '', source });
    const t = tidyWeb(
      { isCompanySite: true, officialName: item('株式会社テスト', 'https://a/'), address: item('', ''), employees: item('50名', 'https://evil/'), capital: item('1億円', 'https://a/about'), sales: item('', '') },
      new Set(['https://a/', 'https://a/about']),
    );
    expect(t).toEqual({ officialName: { value: '株式会社テスト', asOf: '', source: 'https://a/' }, address: null, employees: null, capital: { value: '1億円', asOf: '', source: 'https://a/about' }, sales: null });
    expect(tidyWeb({ isCompanySite: false, officialName: item('x', 'https://a/'), address: item('', ''), employees: item('', ''), capital: item('', ''), sales: item('', '') }, new Set(['https://a/'])).officialName).toBeNull();
  });
});

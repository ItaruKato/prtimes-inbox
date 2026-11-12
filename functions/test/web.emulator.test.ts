/**
 * 会社 HP の読み込みの結合テスト（Firestore エミュレーター。ないときは飛ばす）。npm run test:emulator で動く
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { webSweep, type FetchResult, type WebFields } from '../src/web';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
let db: Firestore;

const SITE: Record<string, string> = {
  'https://www.test-shoji.co.jp/robots.txt': 'User-agent: *\nDisallow: /secret',
  'https://www.test-shoji.co.jp/': '<title>テスト商事｜トップ</title><a href="/company/">会社概要</a><a href="/secret/">会社情報（秘密）</a>',
  'https://www.test-shoji.co.jp/company/': '<title>会社概要</title><table><tr><th>資本金</th><td>1億円</td></tr><tr><th>売上高</th><td>32億円（2025年3月期）</td></tr></table>',
};
const fetched: string[] = [];
const get = async (url: string): Promise<FetchResult> =>
  fetched.push(url) && SITE[url] !== undefined ? { url, status: 200, type: 'text/html', body: SITE[url] } : { url, status: 404, type: 'text/html', body: '' };

const item = (value: string, source = '', asOf = '') => ({ value, asOf, source });

function fakeClient(answer: WebFields, seen: string[], search?: string) {
  return () =>
    ({
      beta: {
        messages: {
          parse: async (req: { messages: { content: string }[] }) => {
            seen.push(req.messages[0].content);
            return { parsed_output: answer, stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } };
          },
          create: async () => ({
            stop_reason: 'end_turn',
            model: 'claude-opus-5-5',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'text', text: search ? `見つかりました。\nURL: ${search}` : 'URL: なし' }],
          }),
        },
      },
    }) as unknown as Anthropic;
}

describe.skipIf(!HOST)('会社 HP の読み込み（エミュレーター）', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  const answer: WebFields = {
    isCompanySite: true,
    officialName: item('株式会社テスト商事', 'https://www.test-shoji.co.jp/'),
    address: item(''),
    employees: item(''),
    capital: item('1億円', 'https://www.test-shoji.co.jp/company/'),
    sales: item('32億円', 'https://www.test-shoji.co.jp/company/', '2025年3月期'),
  };

  it('台帳の HP を robots.txt を守って読み、出どころ付きで台帳に書く', async () => {
    await db.doc('companies/100').set({ name: '株式会社テスト商事', profile: { url: 'https://www.test-shoji.co.jp/' } });
    await db.doc('webQueue/100').set({ at: new Date(), by: 'test' });
    const seen: string[] = [];
    const r = await webSweep({ db, client: fakeClient(answer, seen), get, sleep: async () => {} });
    expect(r).toMatchObject({ done: 1, left: 0 });
    expect(seen[0]).toContain('資本金｜1億円');
    expect(fetched).not.toContain('https://www.test-shoji.co.jp/secret/');
    const c = (await db.doc('companies/100').get()).data()!;
    expect(c.web).toMatchObject({ state: 'done', urlFrom: 'profile', capital: { value: '1億円' }, sales: { value: '32億円', asOf: '2025年3月期' }, address: null });
    expect((await db.doc('companyWeb/100').get()).get('pages')).toHaveLength(2);

    // 読んだばかりなら、もう一度依頼されても読まない（redo なら読む）
    await db.doc('webQueue/100').set({ at: new Date() });
    expect(await webSweep({ db, client: fakeClient(answer, []), get, sleep: async () => {} })).toMatchObject({ fresh: 1 });
    await db.doc('webQueue/100').set({ at: new Date(), redo: true });
    expect(await webSweep({ db, client: fakeClient(answer, []), get, sleep: async () => {} })).toMatchObject({ done: 1 });
  });

  it('台帳に HP がなければ Web 検索で探し、会社名がページにあるときだけ使う', async () => {
    await db.doc('companies/200').set({ name: '株式会社テスト商事' });
    await db.doc('webQueue/200').set({ at: new Date() });
    expect(await webSweep({ db, client: fakeClient(answer, [], 'https://www.test-shoji.co.jp/'), get, sleep: async () => {} })).toMatchObject({ done: 1 });
    expect((await db.doc('companies/200').get()).get('web.urlFrom')).toBe('search');

    await db.doc('companies/300').set({ name: '株式会社まったく別' });
    await db.doc('webQueue/300').set({ at: new Date() });
    expect(await webSweep({ db, client: fakeClient(answer, [], 'https://www.test-shoji.co.jp/'), get, sleep: async () => {} })).toMatchObject({ nosite: 1 });
    expect((await db.doc('companies/300').get()).get('web.state')).toBe('nosite');
  });
});

/**
 * 業界タグの結合テスト（Firestore エミュレーター。ないときは飛ばす）。npm run test:emulator で動く
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { industrySweep } from '../src/industry';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
let db: Firestore;

function fakeClient(seen: { model: string; content: string }[]) {
  return () =>
    ({
      beta: {
        messages: {
          parse: async (req: { model: string; messages: { content: string }[] }) => {
            seen.push({ model: req.model, content: req.messages[0].content });
            const main = req.model.includes('haiku') ? 'si' : 'saas';
            return { parsed_output: { main, subs: ['ai', main], biz: 'btob', confidence: 'high', reason: '法人向けクラウド' }, stop_reason: 'end_turn', model: req.model, usage: { input_tokens: 10, output_tokens: 5 } };
          },
        },
      },
    }) as unknown as Anthropic;
}

describe.skipIf(!HOST)('業界タグ（エミュレーター）', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('依頼を処理して AI ごとに結果を残し、apply の AI だけ台帳に書く。依頼は消す', async () => {
    await db.doc('companies/101').set({ name: '株式会社テスト', profile: { industry: '情報通信' } });
    await db.doc('companyArticles/101').set({ a: { '000000001.000000101': { t: '勤怠管理クラウドに新機能', p: '2026-11-01T10:00:00+09:00' } } });
    await db.doc('companies/102').set({ name: 'B社' });
    await db.doc('industryQueue/101').set({ models: ['sonnet', 'haiku'], at: Timestamp.now(), by: 'longlist' });
    await db.doc('industryQueue/102').set({ models: ['sonnet'], apply: 'sonnet', at: Timestamp.now(), by: 'longlist' });
    await db.doc('industryQueue/999').set({ models: ['sonnet'], at: Timestamp.now() }); // 台帳にない会社
    const seen: { model: string; content: string }[] = [];
    const r = await industrySweep({ db, client: fakeClient(seen) });
    expect(r).toMatchObject({ sonnet: 2, haiku: 1, notfound: 1, left: 0 });
    expect(seen.find((s) => s.content.includes('勤怠管理クラウドに新機能'))).toBeTruthy();
    const t1 = (await db.doc('industryTrials/101').get()).data()!;
    expect(t1.sonnet).toMatchObject({ main: 'saas', subs: ['ai'], biz: 'btob', model: 'claude-sonnet-5-5' });
    expect(t1.haiku).toMatchObject({ main: 'si', model: 'claude-haiku-5-5' });
    expect((await db.doc('companies/101').get()).get('industryTags')).toBeUndefined();
    expect((await db.doc('companies/102').get()).get('industryTags')).toMatchObject({ main: 'saas' });
    expect((await db.collection('industryQueue').get()).size).toBe(0);
    expect((await db.doc('meta/industryTags').get()).get('tags').length).toBe(46);

    // 同じ AI の答えがあれば読み直さない（別の AI だけ聞く）
    await db.doc('industryQueue/101').set({ models: ['sonnet', 'opus'], at: Timestamp.now() });
    const seen2: { model: string; content: string }[] = [];
    expect(await industrySweep({ db, client: fakeClient(seen2) })).toMatchObject({ opus: 1, left: 0 });
    expect(seen2.map((s) => s.model)).toEqual(['claude-opus-5-5']);
    expect((await db.doc('industryTrials/101').get()).get('sonnet.main')).toBe('saas');
  }, 60_000);
});

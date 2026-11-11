/**
 * Firestore エミュレーターでの結合テスト（エミュレーターがないときは飛ばす）。
 * 実行: リポジトリのルートで
 *   npx -y firebase-tools@14.11.0 emulators:exec --only firestore "cd functions && npx vitest run test/emulator.test.ts"
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { store } from '../src/collect';
import { enrich } from '../src/enrich';
import { backfill, BACKFILL_FROM } from '../src/backfill';
import { cleanup } from '../src/cleanup';
import { BUCKET_MAX_BYTES, BUCKET_MAX_INDEX, BUCKET_TARGET_BYTES, docSize, indexEntries, LEAD_MAX } from '../src/buckets';
import type { RawItem } from '../src/parse';
import type { Article } from '../src/types';
import { bigArticle } from './helpers';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
let db: Firestore;

async function clear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
}

/** 画面と同じ読み方（全ドキュメントの items を記事IDでまとめる） */
async function readAll(): Promise<{ docs: { id: string; bytes: number; index: number; count: number }[]; items: Map<string, Article>; dup: number }> {
  const snap = await db.collection('buckets').get();
  const items = new Map<string, Article>();
  let dup = 0;
  const docs = snap.docs.map((d) => {
    const data = d.data();
    const its = (data.items ?? {}) as Record<string, Article>;
    for (const [id, a] of Object.entries(its)) {
      if (items.has(id)) dup++;
      items.set(id, a);
    }
    return { id: d.id, bytes: docSize(d.id, data), index: indexEntries(data), count: Object.keys(its).length };
  });
  return { docs, items, dup };
}

const toRaw = (a: Article): RawItem => ({
  id: a.id,
  url: a.url,
  title: a.title,
  company: a.company,
  publishedAt: a.publishedAt,
  lead: a.lead,
  keywords: a.keywords,
  ticker: a.ticker,
});
const noFetch = async (url: string): Promise<string> => {
  throw new Error(`unexpected fetch ${url}`);
};

/** Claude の代わり。判定は全件「高」、要約は上限いっぱいの長さ */
function fakeClient(opts: { judge?: (lines: { id: string; title: string }[]) => unknown; summaryDelayMs?: number } = {}) {
  const calls = { judge: 0, summary: 0 };
  const client = {
    messages: {
      parse: async (req: { messages: { content: string }[] }) => {
        calls.judge++;
        const lines = req.messages[0].content.split('\n').slice(1).map((l) => JSON.parse(l));
        if (opts.judge) return opts.judge(lines);
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
          parsed_output: { results: lines.map((x: { id: string }) => ({ id: x.id, score: 'high', tags: ['fund'], reason: '資金調達', exclude: '' })) },
        };
      },
    },
    beta: {
      messages: {
        parse: async () => {
          calls.summary++;
          if (opts.summaryDelayMs) await new Promise((r) => setTimeout(r, opts.summaryDelayMs));
          return {
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
            parsed_output: {
              summary: 'う'.repeat(1000),
              points: Array.from({ length: 12 }, () => ({ label: 'え'.repeat(50), value: 'お'.repeat(300) })),
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe.skipIf(!HOST)('Firestore エミュレーター', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(clear);

  it('サイズの見積もりがエミュレーターの 1 MiB 上限と合っている', async () => {
    const mk = (n: number) => ({ items: { x: { lead: 'a'.repeat(n) } } });
    const base = docSize('cal', mk(0));
    const okLen = 1_048_576 - base - 200;
    await db.collection('buckets').doc('cal').set(mk(okLen)); // 上限の少し手前は書ける
    let failed = false;
    try {
      await db.collection('buckets').doc('cal2').set(mk(1_048_576 - base + 200)); // 少し超えると書けない
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('混む1時間（700件・長い冒頭文）を分けて保存し、2回目は重複しない', async () => {
    const hour = '2026110910';
    const arts = Array.from({ length: 700 }, (_, i) => bigArticle(i, hour, 300));
    const r1 = await store({ db, get: noFetch, now: () => new Date('2026-11-09T01:05:00Z') }, arts.map(toRaw), 'collector');
    expect(r1.added).toBe(700);
    let all = await readAll();
    expect(all.items.size).toBe(700);
    expect(all.dup).toBe(0);
    expect(all.docs.length).toBeGreaterThan(1);
    for (const d of all.docs) {
      expect(d.id.slice(0, 10)).toBe(hour);
      expect(d.bytes).toBeLessThanOrEqual(BUCKET_TARGET_BYTES);
    }
    const one = all.items.get(arts[0].id)!;
    expect(one.lead.length).toBe(LEAD_MAX);
    expect(one.keywords.length).toBe(8);

    // 同じ記事をもう一度：続きのドキュメントにある記事も保存済みとして飛ばす
    const r2 = await store({ db, get: noFetch }, arts.map(toRaw), 'collector');
    expect(r2).toMatchObject({ added: 0, updated: 0 });

    // さらに 300 件（重複 100 件を含む）
    const more = Array.from({ length: 300 }, (_, i) => bigArticle(600 + i, hour, 300));
    const r3 = await store({ db, get: noFetch }, more.map(toRaw), 'collector');
    expect(r3.added).toBe(200);
    all = await readAll();
    expect(all.items.size).toBe(900);
    expect(all.dup).toBe(0);
    for (const d of all.docs) expect(d.bytes).toBeLessThanOrEqual(BUCKET_TARGET_BYTES);

    // 会社名が空の記事は後の回で更新される。その間に Claude が書いた判定は上書きしない
    const lone: RawItem = { ...toRaw(bigArticle(0, hour)), id: '000099999.000099999', url: 'https://prtimes.jp/main/html/rd/p/000099999.000099999.html', company: '' };
    await store({ db, get: async () => '<html></html>', sleep: async () => {} }, [lone], 'collector');
    const snapAll = await db.collection('buckets').get();
    const holder = snapAll.docs.find((d) => d.data().items?.[lone.id])!;
    expect(holder.data().items[lone.id].company).toBe('');
    await holder.ref.set({ items: { [lone.id]: { ai: { score: 'high', by: 'claude-haiku-5-5', reason: 'x', tags: [] } } } }, { merge: true });
    const r4 = await store({ db, get: noFetch }, [{ ...lone, company: '会社X' }], 'collector');
    expect(r4).toMatchObject({ added: 0, updated: 1 });
    const after = (await readAll()).items.get(lone.id)!;
    expect(after.company).toBe('会社X');
    expect(after.ai?.by).toBe('claude-haiku-5-5');
  }, 120_000);

  it('一覧から取り込んだ冒頭文なしの記事が多い時間（索引の項目数）も分ける', async () => {
    const hour = '2026110911';
    const arts = Array.from({ length: 1600 }, (_, i) => ({ ...bigArticle(i, hour, 0), keywords: [] }));
    await store({ db, get: noFetch }, arts.map(toRaw), 'backfillStore');
    const all = await readAll();
    expect(all.items.size).toBe(1600);
    for (const d of all.docs) expect(d.index).toBeLessThanOrEqual(BUCKET_MAX_INDEX);
    expect(all.docs.length).toBeGreaterThan(1);
  }, 120_000);

  it('要約で 1 MiB に近づくドキュメントは、要約した記事を続きのドキュメントへ移す', async () => {
    // 古い作り（分割前）で大きくなったドキュメントを再現：Claude 判定済み「高」・要約なし
    const hour = jstHourAgo(2);
    const items: Record<string, Article> = {};
    let n = 0;
    for (; docSize(hour, { items, updatedAt: 'x' }) < 880_000; n++) {
      const a = bigArticle(n, hour, 300);
      items[a.id] = { ...a, ai: { score: 'high', reason: '資金調達', tags: ['fund'], by: 'claude-haiku-5-5' } };
    }
    await db.collection('buckets').doc(hour).set({ items, updatedAt: 'x' });
    const { client, calls } = fakeClient();
    const r = (await enrich({ db, client, get: async () => '<div id="press-release-body"><p>本文</p></div>' })) as Record<string, unknown>;
    expect(calls.summary).toBe(60);
    expect(r.summarized).toBe(60);
    expect(r.moved).toBeGreaterThan(0);
    const all = await readAll();
    expect(all.items.size).toBe(n);
    expect(all.dup).toBe(0);
    for (const d of all.docs) expect(d.bytes).toBeLessThanOrEqual(BUCKET_MAX_BYTES);
    const withSummary = [...all.items.values()].filter((a) => a.ai?.summary);
    expect(withSummary.length).toBe(60);
    // 長すぎる要約は切り詰める
    expect(withSummary[0].ai!.summary!.length).toBe(400);
    expect(withSummary[0].ai!.points!.length).toBe(8);
    // 移した記事も記事の項目がそろっている
    for (const a of withSummary) expect(a.title && a.url && a.publishedAt).toBeTruthy();
  }, 120_000);

  it('利用上限（429）に当たったら、その回は判定のリクエストを送り続けない', async () => {
    const hour = jstHourAgo(1);
    const arts = Array.from({ length: 400 }, (_, i) => bigArticle(i, hour, 100));
    await store({ db, get: noFetch }, arts.map(toRaw), 'collector');
    const { client, calls } = fakeClient({
      judge: () => {
        throw Object.assign(new Error('429 rate_limit_error'), { status: 429 });
      },
    });
    const r = (await enrich({ db, client })) as Record<string, unknown>;
    expect(calls.judge).toBeLessThanOrEqual(2);
    expect(r).toMatchObject({ judged: 0, judgeStoppedBy: 'rateLimit', backlog: 400 });
    const meta = (await db.doc('meta/ai').get()).data()!;
    expect(meta.judgeErrors).toBeGreaterThan(0);
    // 失敗した記事はルール判定のまま（次の回にやり直す）
    expect([...(await readAll()).items.values()].every((a) => a.ai?.by.startsWith('rule'))).toBe(true);
  }, 120_000);

  it('応答がない（通信エラー）ときは、件数を分けて送り直さず、その回は送らない', async () => {
    const hour = jstHourAgo(1);
    await store({ db, get: noFetch }, Array.from({ length: 200 }, (_, i) => toRaw(bigArticle(i, hour, 50))), 'collector');
    const { client, calls } = fakeClient({
      judge: () => {
        throw new APIConnectionTimeoutError();
      },
    });
    const r = (await enrich({ db, client })) as Record<string, unknown>;
    expect(calls.judge).toBeLessThanOrEqual(2);
    expect(r).toMatchObject({ judged: 0, judgeStoppedBy: 'connection', backlog: 200 });
  }, 120_000);

  it('断られた記事だけを切り分け、残りは判定する。断られた記事は次から送らない', async () => {
    const hour = jstHourAgo(1);
    const arts = Array.from({ length: 40 }, (_, i) => bigArticle(i, hour, 50));
    arts[17] = { ...arts[17], title: 'BAD ' + arts[17].title };
    await store({ db, get: noFetch }, arts.map(toRaw), 'collector');
    const judge = (lines: { id: string; title: string }[]) =>
      lines.some((l) => l.title.startsWith('BAD'))
        ? { stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 }, parsed_output: null }
        : {
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 10 },
            parsed_output: { results: lines.map((x) => ({ id: x.id, score: 'low', tags: [], reason: '該当なし', exclude: '' })) },
          };
    const f1 = fakeClient({ judge });
    const r1 = (await enrich({ db, client: f1.client })) as Record<string, unknown>;
    expect(r1).toMatchObject({ judged: 39, refused: 1, backlog: 0 });
    const bad = (await readAll()).items.get(arts[17].id)!;
    expect(bad.ai).toMatchObject({ by: 'rule-v0', skipped: 'refusal' });
    const f2 = fakeClient({ judge });
    await enrich({ db, client: f2.client });
    expect(f2.calls.judge).toBe(0);
  }, 120_000);

  it('同時に2回起動されても、判定・要約は1回分だけ', async () => {
    const hour = jstHourAgo(1);
    await store({ db, get: noFetch }, Array.from({ length: 50 }, (_, i) => toRaw(bigArticle(i, hour, 50))), 'collector');
    const f = fakeClient({ summaryDelayMs: 300 });
    const first = enrich({ db, client: f.client, get: async () => '' });
    // 1回目が鍵を取ってから2回目を起動する
    while (!(await db.doc('locks/enrich').get()).exists) await new Promise((r) => setTimeout(r, 20));
    const second = await enrich({ db, client: f.client, get: async () => '' });
    expect(second).toEqual({ skipped: true });
    await first;
    expect(f.calls.judge).toBe(2); // 50件 = 40 + 10
    expect(f.calls.summary).toBe(50);
    // 終わったら鍵は外れている
    expect((await db.doc('locks/enrich').get()).exists).toBe(false);
  }, 120_000);

  it('さかのぼり取得：途中で空のページが来ても終わりにせず、BACKFILL_FROM を越えたら終わる', async () => {
    const page = (items: { id: string; t: string }[], next: string | null) =>
      items
        .map(
          (x) =>
            `<article class="list-article"><a href="/main/html/rd/p/${x.id}.html"><h3 class="t">記事${x.id}</h3></a>` +
            `<time datetime="${x.t}"></time><a class="list-article__company-name-link" href="#">会社${x.id}</a></article>`,
        )
        .join('') + (next ? `<a href="/main/html/newarrival?pagination_cursor=${next}" class="list-article__more-link">もっと見る</a>` : '');
    const pages: Record<string, string> = {
      first: page([{ id: '000000001.000000001', t: '2026-11-08T10:00:00+0900' }], '111_1'),
      '111_1': '<html>メンテナンス中</html>',
    };
    const get = async (url: string) => {
      const c = url.match(/pagination_cursor=([0-9_]+)/)?.[1] ?? 'first';
      if (c === '222_2') throw new Error(`${url} -> HTTP 503`);
      return pages[c];
    };
    const r1 = await backfill({ db, get, sleep: async () => {} });
    expect(r1).toMatchObject({ done: false, pages: 2, stored: 1 });
    let st = (await db.doc('meta/backfill').get()).data()!;
    expect(st).toMatchObject({ done: false, cursor: '111_1' });
    expect(st.lastError).toContain('記事がありません');

    // 同じカーソルから続ける。取得エラーでも読めたところまでは保存する
    pages['111_1'] = page([{ id: '000000002.000000001', t: '2026-11-05T10:00:00+0900' }], '222_2');
    const r2 = await backfill({ db, get, sleep: async () => {} });
    expect(r2).toMatchObject({ done: false, pages: 1, stored: 1 });
    st = (await db.doc('meta/backfill').get()).data()!;
    expect(st.cursor).toBe('222_2');
    expect(st.lastError).toContain('HTTP 503');

    pages['222_2'] = page(
      [
        { id: '000000003.000000001', t: '2026-11-01T00:30:00+0900' },
        { id: '000000004.000000001', t: '2026-10-31T23:50:00+0900' },
      ],
      '333_3',
    );
    const get2 = async (url: string) => pages[url.match(/pagination_cursor=([0-9_]+)/)?.[1] ?? 'first'];
    const r3 = await backfill({ db, get: get2, sleep: async () => {} });
    expect(r3).toMatchObject({ done: true, stored: 1 });
    st = (await db.doc('meta/backfill').get()).data()!;
    expect(st).toMatchObject({ done: true, from: BACKFILL_FROM, lastError: null });
    expect((await readAll()).items.size).toBe(3);
    // 終わった後は何もしない
    expect(await backfill({ db, get: noFetch })).toMatchObject({ done: true, pages: 0 });
  }, 120_000);

  it('cleanup は30日より前の時間バケット（続きのドキュメントも）と振り分けだけを消す', async () => {
    const now = new Date('2026-12-10T03:00:00Z'); // JST 12/10 12時 → 11/10 12時より前を消す
    for (const id of ['2026111011', '2026111011_2', '2026111012', '2026111012_2', '2026111013'])
      await db.collection('buckets').doc(id).set({ items: {} });
    for (const id of ['20261109', '20261110']) await db.collection('decisions').doc(id).set({ d: {} });
    await db.collection('saved').doc('x').set({ a: 1 });
    const r = await cleanup(db, now, 30);
    expect(r.deleted).toBe(3);
    expect((await db.collection('buckets').get()).docs.map((d) => d.id)).toEqual(['2026111012', '2026111012_2', '2026111013']);
    expect((await db.collection('decisions').get()).docs.map((d) => d.id)).toEqual(['20261110']);
    expect((await db.collection('saved').get()).size).toBe(1);
  });
});

/** 今から h 時間前の JST の YYYYMMDDHH（enrich は直近10日分だけを見るため） */
function jstHourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3600e3 + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

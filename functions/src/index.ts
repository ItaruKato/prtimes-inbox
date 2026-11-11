import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import Anthropic from '@anthropic-ai/sdk';
import { collect } from './collect';
import { cleanup } from './cleanup';
import { enrich } from './enrich';
import { backfill } from './backfill';

initializeApp();
const db = getFirestore();

const common = { region: 'asia-northeast1', timeZone: 'Asia/Tokyo' } as const;
const anthropicKey = defineSecret('ANTHROPIC_API_KEY');

/**
 * Claude による判定・要約を行うか。
 * いまは停止中（AIの判定が低くても読みたい記事が埋もれていたため。画面は新作ゲーム以外をすべて受信箱に入れる）。
 * 戻すときは true にし、画面側の src/lib/flags.ts の AI_SCORING も true にする。
 */
const AI_ENABLED = false;

/** 1時間ごとに PR TIMES の新着を取得（毎時5分） */
export const collectHourly = onSchedule(
  { ...common, schedule: '5 * * * *', timeoutSeconds: 540, memory: '512MiB', retryCount: 1 },
  async () => {
    await collect({ db, log: (msg, data) => logger.info(msg, data) });
  },
);

/**
 * 取得した記事を Claude で判定・要約（20分ごと：毎時10分・30分・50分。10分の回は取得（5分）の直後）。
 * 1回あたりの同時リクエストは少なめにして、短い間隔で回数を増やす（利用上限に当たりにくく、たまった分も早く減る）。
 * 1回は約10分で新しいリクエストを送るのをやめる。重なったときは locks/enrich で後の回が何もしない。
 * 関数名は以前のまま（変えるとデプロイで消して作り直しになるため）。
 */
export const enrichHourly = onSchedule(
  { ...common, schedule: '10,30,50 * * * *', timeoutSeconds: 1200, memory: '1GiB', secrets: [anthropicKey] },
  async () => {
    // 429（利用上限）・529（混雑）は SDK が retry-after に従って2回までやり直す。応答が止まったときは 150 秒で打ち切る
    if (!AI_ENABLED) return;
    const client = new Anthropic({ apiKey: anthropicKey.value(), maxRetries: 2, timeout: 150_000 });
    await enrich({ db, client, log: (msg, data) => logger.info(msg, data) });
  },
);

/** 11月1日以降の記事をさかのぼって取り込む（10分ごとに少しずつ。終わったら何もしない） */
export const backfillPast = onSchedule(
  { ...common, schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    await backfill({ db, log: (msg, data) => logger.info(msg, data) });
  },
);

/** 毎日4時に古いデータを削除（いまは保存期間を無期限にしているので何もしない。cleanup.ts の RETENTION_DAYS で変更） */
export const cleanupDaily = onSchedule({ ...common, schedule: '0 4 * * *', timeoutSeconds: 300 }, async () => {
  const r = await cleanup(db, new Date());
  logger.info('cleanup done', r);
});

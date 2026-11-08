import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { collect } from './collect';
import { cleanup } from './cleanup';

initializeApp();
const db = getFirestore();

const common = { region: 'asia-northeast1', timeZone: 'Asia/Tokyo' } as const;

/** 1時間ごとに PR TIMES の新着を取得 */
export const collectHourly = onSchedule(
  { ...common, schedule: '5 * * * *', timeoutSeconds: 540, memory: '512MiB', retryCount: 1 },
  async () => {
    await collect({ db, log: (msg, data) => logger.info(msg, data) });
  },
);

/** 毎日4時に古いデータを削除（「読む」「既読」に入れた記事は saved に残るので消えない） */
export const cleanupDaily = onSchedule({ ...common, schedule: '0 4 * * *' }, async () => {
  const r = await cleanup(db, new Date());
  logger.info('cleanup done', r);
});

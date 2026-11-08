import type { Firestore } from 'firebase-admin/firestore';

/** 受信箱・候補・不要の記事を残す日数（「読む」「既読」は saved に無期限で残る） */
export const RETENTION_DAYS = 30;

const jstKey = (d: Date, len: 8 | 10) => {
  const t = new Date(d.getTime() + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}`.slice(0, len);
};

export async function cleanup(db: Firestore, now: Date) {
  const limit = new Date(now.getTime() - RETENTION_DAYS * 86400e3);
  let deleted = 0;
  for (const [col, len] of [['buckets', 10], ['decisions', 8]] as const) {
    const old = await db.collection(col).where('__name__', '<', db.collection(col).doc(jstKey(limit, len))).get();
    for (let i = 0; i < old.docs.length; i += 400) {
      const batch = db.batch();
      for (const d of old.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
    deleted += old.size;
  }
  return { deleted, before: jstKey(limit, 10) };
}

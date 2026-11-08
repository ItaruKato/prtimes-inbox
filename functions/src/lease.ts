import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * 同じ処理が重なって動かないようにする（スケジューラーは同じ回を2度起動することがあり、
 * 前の回が長引いたときに次の回が始まることもある）。
 * locks/{name} に期限つきの印を付け、期限内なら後から来た方は何もしない。
 * 処理が途中で落ちても期限が切れれば次の回が動く。
 */
export async function withLease<T>(
  db: Firestore,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false; until: number }> {
  const ref = db.collection('locks').doc(name);
  const token = randomUUID();
  const got = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const until = s.get('until') as number | undefined;
    const now = Date.now();
    if (s.exists && typeof until === 'number' && until > now) return { ok: false as const, until };
    tx.set(ref, { token, until: now + ttlMs, startedAt: new Date(now).toISOString() });
    return { ok: true as const };
  });
  if (!got.ok) return { ran: false, until: got.until };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await db
      .runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.get('token') === token) tx.delete(ref);
      })
      .catch(() => {});
  }
}

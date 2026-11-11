import type { Firestore } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import { matchRules } from '../../src/lib/exclusion';
import type { Article } from './types';

/**
 * 毎朝の通知（9時）。画面と同じ自動除外ルール（src/lib/exclusion.ts）で受信箱に入る記事を数える。
 * いまは AI のおすすめ度判定を止めているので「自動除外に当たらず、まだ振り分けていない記事」を受信箱として数える。
 */
const DAY = 86400e3;
const JST = 9 * 3600e3;
const p2 = (n: number) => String(n).padStart(2, '0');
const jstKey = (ms: number, len: 8 | 10) => {
  const d = new Date(ms + JST);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`.slice(0, len);
};
/** その日の 0:00（JST）のミリ秒 */
const jstDayStart = (ms: number) => {
  const d = new Date(ms + JST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - JST;
};

const TAG_LABEL: Record<string, string> = { fund: '資金調達', ma: 'M&A', ipo: '上場', new: '新規事業', mkt: 'マーケ' };

export interface MorningSummary {
  /** 前日（JST）の日付 例: 11月11日 */
  date: string;
  /** 前日の新着のうち受信箱に入った（未処理の）件数 */
  newInbox: number;
  /** 上のうちタグごとの件数 */
  tags: Record<string, number>;
  /** 直近7日（前日まで）の未処理の件数 */
  unprocessed: number;
}

export async function morningSummary(db: Firestore, now: Date): Promise<MorningSummary> {
  const today = jstDayStart(now.getTime());
  const yesterday = today - DAY;
  const since = today - 7 * DAY;

  const buckets = await db
    .collection('buckets')
    .where(FieldPath.documentId(), '>=', jstKey(since, 8) + '00')
    .where(FieldPath.documentId(), '<', jstKey(today, 8) + '00')
    .get();
  const decSnap = await db.collection('decisions').where(FieldPath.documentId(), '>=', jstKey(since, 8)).get();
  const decisions: Record<string, { status: string }> = {};
  for (const d of decSnap.docs) Object.assign(decisions, d.data().d ?? {});
  const disabled = new Set<string>(((await db.doc('config/exclusion').get()).data()?.disabledRules ?? []) as string[]);

  let newInbox = 0;
  let unprocessed = 0;
  const tags: Record<string, number> = {};
  const seen = new Set<string>();
  for (const b of buckets.docs)
    for (const a of Object.values((b.data().items ?? {}) as Record<string, Article>)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const ts = new Date(a.publishedAt).getTime();
      if (!(ts >= since && ts < today)) continue;
      const excluded = matchRules(a).some((id) => !disabled.has(id));
      const status = decisions[a.id]?.status ?? (excluded ? 'drop' : 'inbox');
      if (status !== 'inbox') continue;
      unprocessed++;
      if (ts >= yesterday) {
        newInbox++;
        for (const t of a.ai?.tags ?? []) tags[t] = (tags[t] ?? 0) + 1;
      }
    }
  const y = new Date(yesterday + JST);
  return { date: `${y.getUTCMonth() + 1}月${y.getUTCDate()}日`, newInbox, tags, unprocessed };
}

export function morningMessage(s: MorningSummary): { title: string; body: string } {
  const n = (x: number) => x.toLocaleString('ja-JP');
  const tagText = ['fund', 'ma', 'ipo', 'new', 'mkt']
    .filter((k) => s.tags[k])
    .map((k) => `${TAG_LABEL[k]} ${n(s.tags[k])}`)
    .join('・');
  return {
    title: `${s.date}の新着 ${n(s.newInbox)}件`,
    body: `${tagText ? `${tagText}。` : ''}直近7日の未処理は ${n(s.unprocessed)}件です。`,
  };
}

/** 登録されている端末すべてに送る。無効になった端末の登録は消す */
export async function sendToAll(db: Firestore, messaging: Messaging, msg: { title: string; body: string }) {
  const snap = await db.collection('pushTokens').get();
  const tokens = snap.docs.map((d) => ({ ref: d.ref, token: String(d.data().token ?? '') })).filter((t) => t.token);
  let success = 0;
  let removed = 0;
  const errors: string[] = [];
  if (tokens.length) {
    const res = await messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      webpush: {
        notification: { title: msg.title, body: msg.body, icon: '/icon-192.png', tag: 'morning', renotify: true },
        fcmOptions: { link: 'https://prtimes-inbox.web.app/' },
      },
      data: { url: '/', title: msg.title, body: msg.body },
    });
    success = res.successCount;
    await Promise.all(
      res.responses.map(async (r, i) => {
        if (r.success) return;
        const code = r.error?.code ?? '';
        errors.push(code || String(r.error));
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          await tokens[i].ref.delete();
          removed++;
        }
      }),
    );
  }
  const result = { at: new Date().toISOString(), title: msg.title, body: msg.body, tokens: tokens.length, success, removed, errors };
  await db.doc('meta/push').set(result);
  return result;
}

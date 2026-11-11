import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import { indexKey, toEntry, type IndexEntry } from '../../src/lib/dayIndex';
import type { Article } from './types';

/** 目次（days）に書き込む操作を作る。記事は6時間ごとのドキュメントにまとめてマージする */
export function indexOps(db: Firestore, articles: Article[]): { bytes: number; apply: (b: WriteBatch) => void }[][] {
  const byKey = new Map<string, Record<string, IndexEntry>>();
  for (const a of articles) {
    if (!a.publishedAt || Number.isNaN(new Date(a.publishedAt).getTime())) continue;
    const k = indexKey(a.publishedAt);
    const m = byKey.get(k) ?? {};
    m[a.id] = toEntry(a as unknown as Parameters<typeof toEntry>[0]);
    byKey.set(k, m);
  }
  return [...byKey].map(([k, items]) => [
    {
      bytes: Buffer.byteLength(JSON.stringify(items)) + 200,
      apply: (b: WriteBatch) => b.set(db.collection('days').doc(k), { items }, { merge: true }),
    },
  ]);
}

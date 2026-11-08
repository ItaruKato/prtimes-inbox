import { describe, expect, it } from 'vitest';
import {
  BUCKET_TARGET_BYTES,
  BUCKET_TARGET_INDEX,
  BucketPlanner,
  docSize,
  indexEntries,
  itemCost,
  partId,
  partNo,
  valueSize,
} from '../src/buckets';
import type { Article } from '../src/types';
import { bigArticle } from './helpers';

describe('valueSize / docSize', () => {
  it('Firestore の計算方法どおり', () => {
    expect(valueSize('abc')).toBe(4);
    expect(valueSize('あ')).toBe(4); // UTF-8 で3バイト + 1
    expect(valueSize(1)).toBe(8);
    expect(valueSize(true)).toBe(1);
    expect(valueSize(null)).toBe(1);
    expect(valueSize(['a', 'b'])).toBe(4);
    expect(valueSize({ a: 'b', c: undefined })).toBe(4);
    // 公式ドキュメントの例: users/jeff の名前は 6+1 + 4+1 + 16 = 28
    expect(docSize('x', {}) - 32).toBe(8 + 2 + 16);
  });
  it('索引の項目数は値ごとに2つ、配列は要素ごとに1つ', () => {
    expect(indexEntries({ a: 'x', b: 1, c: ['p', 'q', 'q'], d: { e: 'y' } })).toBe(2 + 2 + 2 + 2);
  });
});

describe('partId / partNo', () => {
  it('続きのドキュメントの名前', () => {
    expect(partId('2026110910', 1)).toBe('2026110910');
    expect(partId('2026110910', 3)).toBe('2026110910_3');
    expect(partNo('2026110910')).toBe(1);
    expect(partNo('2026110910_12')).toBe(12);
    // 続きのドキュメントは、同じ時間の本体より後・次の時間より前に並ぶ（画面・cleanup の範囲指定のため）
    expect('2026110910_2' > '2026110910').toBe(true);
    expect('2026110910_2' < '2026110911').toBe(true);
  });
});

describe('BucketPlanner', () => {
  it('700件の混む1時間を、上限を超えないように複数のドキュメントに分ける', () => {
    const p = new BucketPlanner([]);
    const placed = new Map<string, number>();
    for (let i = 0; i < 700; i++) {
      const a = bigArticle(i);
      const docId = p.place('2026110910', a.id, a);
      placed.set(docId, (placed.get(docId) ?? 0) + 1);
    }
    expect(placed.size).toBeGreaterThan(1);
    for (const docId of placed.keys()) {
      expect(docId.startsWith('2026110910')).toBe(true);
      const s = p.size(docId)!;
      expect(s.bytes).toBeLessThanOrEqual(BUCKET_TARGET_BYTES);
      expect(s.index).toBeLessThanOrEqual(BUCKET_TARGET_INDEX);
    }
    expect([...placed.values()].reduce((a, b) => a + b, 0)).toBe(700);
  });

  it('既存のドキュメントの大きさを数え、空きがあれば番号の小さい方に入れる', () => {
    const items: Record<string, Article> = {};
    for (let i = 0; i < 300; i++) items[bigArticle(i).id] = bigArticle(i);
    const p = new BucketPlanner([
      { id: '2026110910', data: { items, updatedAt: 'x' } },
      { id: '2026110910_2', data: { items: {}, updatedAt: 'x' } },
    ]);
    expect(p.get(bigArticle(5).id)?.id).toBe(bigArticle(5).id);
    expect(p.where(bigArticle(5).id)).toBe('2026110910');
    const a = bigArticle(1000);
    expect(p.place('2026110910', a.id, a)).toBe('2026110910');
    // 大きな記事が入らなくなったら続きへ
    let last = '';
    for (let i = 1001; i < 1700; i++) last = p.place('2026110910', bigArticle(i).id, bigArticle(i));
    expect(last).not.toBe('2026110910');
  });

  it('入れ替え・削除で大きさが戻る', () => {
    const p = new BucketPlanner([{ id: '2026110910', data: { items: {} } }]);
    const before = p.size('2026110910')!.bytes;
    const a = bigArticle(1);
    p.place('2026110910', a.id, a);
    expect(p.size('2026110910')!.bytes).toBe(before + itemCost(a.id, a).bytes);
    const withSummary = { ...a, ai: { ...a.ai!, summary: 'い'.repeat(300) } };
    p.replace('2026110910', a.id, withSummary);
    expect(p.size('2026110910')!.bytes).toBe(before + itemCost(a.id, withSummary).bytes);
    p.remove('2026110910', a.id);
    expect(p.size('2026110910')!.bytes).toBe(before);
    expect(p.get(a.id)).toBeUndefined();
  });
});

import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import type { Article } from './types';

/**
 * 時間バケット（buckets/{YYYYMMDDHH}）の大きさの管理。
 *
 * Firestore の1ドキュメントは 1 MiB まで、索引の項目数は 40,000 まで。
 * 混む時間帯（月曜10時など）は1時間に数百件のリリースが出るため、1ドキュメントに入りきらないことがある。
 * そのときは同じ時間の続きのドキュメント（YYYYMMDDHH_2, _3, …）に分けて保存する。
 * 画面と cleanup は ID の前方一致・大小比較で読むので、続きのドキュメントもそのまま読まれ・消される。
 */

/** 新しい記事を入れるときの上限（要約が後から加わる分の余裕を残す） */
export const BUCKET_TARGET_BYTES = 700_000;
/** どんな書き込みでもこれを超えないようにする（1 MiB = 1,048,576 バイト） */
export const BUCKET_MAX_BYTES = 950_000;
/** 索引の項目数の目安（上限は 40,000） */
export const BUCKET_TARGET_INDEX = 28_000;
export const BUCKET_MAX_INDEX = 36_000;

/** 新しく保存する記事の本文冒頭・キーワードの上限（ドキュメントの大きさを抑える） */
export const LEAD_MAX = 150;
export const KEYWORDS_MAX = 8;

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/** Firestore の保存サイズの計算方法に沿った見積もり（https://firebase.google.com/docs/firestore/storage-size） */
export function valueSize(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null || typeof v === 'boolean') return 1;
  if (typeof v === 'number' || v instanceof Date) return 8;
  if (typeof v === 'string') return utf8(v) + 1;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + valueSize(x), 0);
  if (typeof v === 'object') {
    // Timestamp など（toMillis を持つもの）は 8 バイト
    if (typeof (v as { toMillis?: unknown }).toMillis === 'function') return 8;
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) n += utf8(k) + 1 + valueSize(x);
    return n;
  }
  return 8;
}

/**
 * 自動で作られる単一フィールド索引の項目数の見積もり。
 * 値ごとに昇順・降順の2つ、配列は要素ごとに1つ（array-contains）、マップは中のフィールドを数える。
 */
export function indexEntries(v: unknown): number {
  if (v === undefined) return 0;
  if (Array.isArray(v)) return new Set(v.map((x) => JSON.stringify(x))).size;
  if (v && typeof v === 'object' && !(v instanceof Date) && typeof (v as { toMillis?: unknown }).toMillis !== 'function') {
    let n = 0;
    for (const x of Object.values(v as Record<string, unknown>)) n += indexEntries(x);
    return n;
  }
  return 2;
}

/** ドキュメント全体の大きさ（名前 + フィールド + 32） */
export function docSize(id: string, data: Record<string, unknown>): number {
  return utf8('buckets') + 1 + utf8(id) + 1 + 16 + valueSize(data) + 32;
}

/** items マップの中の1記事分 */
export function itemCost(id: string, a: unknown): { bytes: number; index: number } {
  return { bytes: utf8(id) + 1 + valueSize(a), index: indexEntries(a) };
}

export const hourOf = (docId: string) => docId.slice(0, 10);
export const partId = (hour: string, n: number) => (n <= 1 ? hour : `${hour}_${n}`);
export const partNo = (docId: string) => (docId.length > 11 && docId[10] === '_' ? Number(docId.slice(11)) || 1 : 1);

interface Part {
  id: string;
  bytes: number;
  index: number;
}

/**
 * 時間バケットとその続きのドキュメントの中身と大きさを持ち、記事の置き場所を決める。
 * 同じ時間の中では、番号の小さいドキュメントから空きのあるところに入れる。
 */
export class BucketPlanner {
  private parts = new Map<string, Part[]>(); // 時間 → ドキュメント（番号順）
  private byId = new Map<string, { docId: string; article: Article }>();
  private partById = new Map<string, Part>();

  constructor(docs: { id: string; data: Record<string, unknown> | undefined }[]) {
    for (const d of docs) {
      const data = d.data ?? {};
      this.addPart(d.id, docSize(d.id, data), indexEntries(data));
      for (const [id, a] of Object.entries((data.items ?? {}) as Record<string, Article>)) {
        // 同じ記事が2か所にあるときは、番号の大きい方（画面でも後から読まれる方）を正とする
        const cur = this.byId.get(id);
        if (!cur || partNo(d.id) >= partNo(cur.docId)) this.byId.set(id, { docId: d.id, article: a });
      }
    }
  }

  private addPart(id: string, bytes: number, index: number): Part {
    const p: Part = { id, bytes, index };
    const hour = hourOf(id);
    const list = this.parts.get(hour) ?? [];
    list.push(p);
    list.sort((a, b) => partNo(a.id) - partNo(b.id));
    this.parts.set(hour, list);
    this.partById.set(id, p);
    return p;
  }

  get(id: string): Article | undefined {
    return this.byId.get(id)?.article;
  }
  where(id: string): string | undefined {
    return this.byId.get(id)?.docId;
  }
  size(docId: string): { bytes: number; index: number } | undefined {
    const p = this.partById.get(docId);
    return p && { bytes: p.bytes, index: p.index };
  }
  docIds(): string[] {
    return [...this.partById.keys()];
  }
  /** 全記事（同じ記事は1件だけ） */
  articles(): Article[] {
    return [...this.byId.values()].map((x) => x.article);
  }

  /** すでにある記事をその場で置き換えたときの大きさの変化を反映する */
  replace(docId: string, id: string, next: Article) {
    const p = this.partById.get(docId) ?? this.addPart(docId, docSize(docId, { items: {}, updatedAt: '' }), 0);
    const prev = this.byId.get(id);
    if (prev && prev.docId === docId) {
      const c = itemCost(id, prev.article);
      p.bytes -= c.bytes;
      p.index -= c.index;
    }
    const c = itemCost(id, next);
    p.bytes += c.bytes;
    p.index += c.index;
    this.byId.set(id, { docId, article: next });
  }

  /** 記事をドキュメントから外したときの大きさの変化を反映する */
  remove(docId: string, id: string) {
    const p = this.partById.get(docId);
    const prev = this.byId.get(id);
    if (!p || !prev || prev.docId !== docId) return;
    const c = itemCost(id, prev.article);
    p.bytes -= c.bytes;
    p.index -= c.index;
    this.byId.delete(id);
  }

  /** 新しい記事の置き場所を決めて、大きさを反映する。返り値はドキュメントID */
  place(hour: string, id: string, a: Article): string {
    const c = itemCost(id, a);
    const list = this.parts.get(hour) ?? [];
    let target = list.find((p) => p.bytes + c.bytes <= BUCKET_TARGET_BYTES && p.index + c.index <= BUCKET_TARGET_INDEX);
    if (!target) {
      const n = list.length ? Math.max(...list.map((p) => partNo(p.id))) + 1 : 1;
      const newId = partId(hour, n);
      target = this.addPart(newId, docSize(newId, { items: {}, updatedAt: '' }), 2);
    }
    target.bytes += c.bytes;
    target.index += c.index;
    this.byId.set(id, { docId: target.id, article: a });
    return target.id;
  }
}

/** 指定した時間のバケットと、その続きのドキュメント（_2, _3, …）をまとめて読む */
export async function loadBuckets(db: Firestore, hours: string[]): Promise<{ id: string; data: Record<string, unknown> | undefined }[]> {
  const out: { id: string; data: Record<string, unknown> | undefined }[] = [];
  const list = [...new Set(hours)];
  // 同時に投げる問い合わせは 8 本まで
  for (let i = 0; i < list.length; i += 8) {
    const snaps = await Promise.all(
      list.slice(i, i + 8).map((h) =>
        db
          .collection('buckets')
          .where(FieldPath.documentId(), '>=', h)
          .where(FieldPath.documentId(), '<=', `${h}_`)
          .get(),
      ),
    );
    for (const s of snaps) for (const d of s.docs) out.push({ id: d.id, data: d.data() });
  }
  return out;
}

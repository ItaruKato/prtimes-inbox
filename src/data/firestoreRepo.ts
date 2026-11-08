import {
  collection,
  deleteField,
  doc,
  documentId,
  onSnapshot,
  query,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { AiStatus, Article, Decision, Item } from '../types';
import { costUsd, type UsageTotals } from '../lib/aiCost';
import type { Repo } from './repo';
import { mockJudge } from '../lib/mockJudge';

/** 画面に読み込む日数（受信箱・候補・不要）。「読む」「既読」は saved から全期間読む */
export const LOAD_DAYS = 10;

/** JST の YYYYMMDD / YYYYMMDDHH */
export function jstKey(ts: number, len: 8 | 10): string {
  const d = new Date(ts + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`.slice(0, len);
}

const toItem = (a: Article): Item => ({ ...a, ts: new Date(a.publishedAt).getTime(), judge: a.ai ?? mockJudge(a) });

interface SavedDoc {
  article: Article;
  decision: Decision;
}

export function createFirestoreRepo(db: Firestore): Repo {
  const byId = new Map<string, Item>();

  return {
    subscribe(onData, onError) {
      const since = Date.now() - LOAD_DAYS * 86400e3;
      let buckets = new Map<string, Record<string, Article>>();
      let dayDecisions = new Map<string, Record<string, Decision>>();
      let saved = new Map<string, SavedDoc>();
      const ready = { buckets: false, decisions: false, saved: false };

      const emit = () => {
        if (!ready.buckets || !ready.decisions || !ready.saved) return;
        byId.clear();
        for (const items of buckets.values()) for (const a of Object.values(items)) byId.set(a.id, toItem(a));
        const decisions: Record<string, Decision> = {};
        for (const [id, s] of saved) {
          if (!byId.has(id)) byId.set(id, toItem(s.article));
          decisions[id] = s.decision;
        }
        for (const m of dayDecisions.values()) Object.assign(decisions, m);
        const items = [...byId.values()].sort((a, b) => b.ts - a.ts);
        onData({ items, decisions });
      };
      const fail = (e: Error) => onError(e);

      const unsubs = [
        onSnapshot(
          query(collection(db, 'buckets'), where(documentId(), '>=', jstKey(since, 10))),
          (snap) => {
            buckets = new Map(snap.docs.map((d) => [d.id, (d.data().items ?? {}) as Record<string, Article>]));
            ready.buckets = true;
            emit();
          },
          fail,
        ),
        onSnapshot(
          query(collection(db, 'decisions'), where(documentId(), '>=', jstKey(since, 8))),
          (snap) => {
            dayDecisions = new Map(snap.docs.map((d) => [d.id, (d.data().d ?? {}) as Record<string, Decision>]));
            ready.decisions = true;
            emit();
          },
          fail,
        ),
        onSnapshot(
          collection(db, 'saved'),
          (snap) => {
            saved = new Map(snap.docs.map((d) => [d.id, d.data() as SavedDoc]));
            ready.saved = true;
            emit();
          },
          fail,
        ),
      ];
      return () => unsubs.forEach((u) => u());
    },

    subscribeAiStatus(onData) {
      // 今月の利用量（日ごとのドキュメント）と、最後の実行結果
      const monthStart = jstKey(Date.now(), 8).slice(0, 6) + '01';
      let usage = 0;
      let meta: Partial<AiStatus> = {};
      const emit = () => onData({ ...meta, monthUsd: usage });
      const u1 = onSnapshot(
        query(collection(db, 'aiUsage'), where(documentId(), '>=', monthStart)),
        (snap) => {
          usage = snap.docs.reduce((sum, d) => sum + costUsd(d.data() as Record<string, UsageTotals>), 0);
          emit();
        },
        () => {},
      );
      const u2 = onSnapshot(
        doc(db, 'meta', 'ai'),
        (d) => {
          meta = (d.data() ?? {}) as Partial<AiStatus>;
          emit();
        },
        () => {},
      );
      return () => {
        u1();
        u2();
      };
    },

    async saveDecisions(changes) {
      // decisions/{記事の配信日} にまとめて書く。「読む」「既読」は記事ごと saved にも残す（無期限）
      const batch = writeBatch(db);
      const perDay = new Map<string, Record<string, Decision | ReturnType<typeof deleteField>>>();
      for (const [id, d] of Object.entries(changes)) {
        const it = byId.get(id);
        if (!it) continue;
        const day = jstKey(it.ts, 8);
        const m = perDay.get(day) ?? {};
        m[id] = d ?? deleteField();
        perDay.set(day, m);
        const savedRef = doc(db, 'saved', id);
        if (d && (d.status === 'keep' || d.status === 'done')) {
          const { ts: _ts, judge: _judge, ...article } = it;
          void _ts;
          void _judge;
          batch.set(savedRef, { article, decision: d });
        } else batch.delete(savedRef);
      }
      for (const [day, m] of perDay) batch.set(doc(db, 'decisions', day), { d: m }, { merge: true });
      await batch.commit();
    },
  };
}

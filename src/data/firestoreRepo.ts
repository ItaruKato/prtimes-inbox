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
  type WriteBatch,
} from 'firebase/firestore';
import type { AiStatus, Article, Decision, Item } from '../types';
import { costUsd, type UsageTotals } from '../lib/aiCost';
import type { Repo } from './repo';
import { toItem } from '../lib/mode';

/** 画面に読み込む日数（受信箱・候補・不要）。「読む」「既読」は saved から全期間読む */
export const LOAD_DAYS = 10;

/** JST の YYYYMMDD / YYYYMMDDHH */
export function jstKey(ts: number, len: 8 | 10): string {
  const d = new Date(ts + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`.slice(0, len);
}


interface SavedDoc {
  article: Article;
  decision: Decision;
}

export function createFirestoreRepo(db: Firestore): Repo {
  const byId = new Map<string, Item>();
  /** saved にドキュメントがある記事（無い記事に削除を送らないため） */
  const savedIds = new Set<string>();

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
          // 開始位置を日単位にそろえ、同じ日のうちは同じクエリにする（開き直しても差分だけ受け取る）
          query(collection(db, 'buckets'), where(documentId(), '>=', jstKey(since, 8) + '00')),
          // キャッシュ→サーバーの切り替わり（件数が同じでも）を受け取るため
          { includeMetadataChanges: true },
          (snap) => {
            // 端末内のキャッシュが空のときは、サーバーの結果を待つ（一瞬「0件」と出さない）
            if (snap.metadata.fromCache && snap.empty) return;
            buckets = new Map(snap.docs.map((d) => [d.id, (d.data().items ?? {}) as Record<string, Article>]));
            ready.buckets = true;
            emit();
          },
          fail,
        ),
        onSnapshot(
          query(collection(db, 'decisions'), where(documentId(), '>=', jstKey(since, 8))),
          // キャッシュ→サーバーの切り替わり（件数が同じでも）を受け取るため
          { includeMetadataChanges: true },
          (snap) => {
            // 0件は普通にある。キャッシュの0件も受け取る（オフラインで開いたとき止まらないように）。
            // 一度も同期していない端末では、SDK がサーバーの結果を待ってから届けるので「0件」は一瞬も出ない
            dayDecisions = new Map(snap.docs.map((d) => [d.id, (d.data().d ?? {}) as Record<string, Decision>]));
            ready.decisions = true;
            emit();
          },
          fail,
        ),
        onSnapshot(
          collection(db, 'saved'),
          // キャッシュ→サーバーの切り替わり（件数が同じでも）を受け取るため
          { includeMetadataChanges: true },
          (snap) => {
            // 0件は普通にある（「読む」「既読」が空）。キャッシュの0件も受け取る（上と同じ理由）
            saved = new Map(snap.docs.map((d) => [d.id, d.data() as SavedDoc]));
            savedIds.clear();
            for (const id of saved.keys()) savedIds.add(id);
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
      const ops: ((b: WriteBatch) => void)[] = [];
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
          ops.push((b) => b.set(savedRef, { article, decision: d }));
          savedIds.add(id);
        } else if (savedIds.has(id)) {
          // 無い記事に削除は送らない（「まとめて不要」が数千件の書き込みになり、端末が固まる）
          ops.push((b) => b.delete(savedRef));
          savedIds.delete(id);
        }
      }
      for (const [day, m] of perDay) ops.push((b) => b.set(doc(db, 'decisions', day), { d: m }, { merge: true }));
      // 1回のバッチは小さく分ける。SDK は端末内の保存で「書き込み数 × バッチ全体」の量を書くため、
      // 大きなバッチは件数の2乗で重くなる（2,000件で十数秒固まる）。
      // commit は待たずに全部出す（オフラインでも後ろのバッチが端末内に入るように）
      const commits: Promise<void>[] = [];
      for (let i = 0; i < ops.length; i += 100) {
        const batch = writeBatch(db);
        for (const op of ops.slice(i, i + 100)) op(batch);
        commits.push(batch.commit());
      }
      await Promise.all(commits);
    },
  };
}

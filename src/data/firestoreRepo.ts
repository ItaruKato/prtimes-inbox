import {
  collection,
  deleteField,
  doc,
  documentId,
  getDocs,
  setDoc,
  onSnapshot,
  query,
  where,
  writeBatch,
  type Firestore,
  type Query,
  type WriteBatch,
} from 'firebase/firestore';
import type { AiStatus, Article, Decision, ExclusionConfig, Item, RuleReport } from '../types';
import { costUsd, type UsageTotals } from '../lib/aiCost';
import type { Repo } from './repo';
import { toItem } from '../lib/mode';
import { rangeStart, type RangeKey } from '../lib/range';
import { fromEntry, type IndexEntry } from '../lib/dayIndex';
import { refreshHandoff, requestDraft } from '../lib/notes';

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

/** range: 読み込む期間（受信箱・不要など）。「読む」「読了」は saved から期間に関係なく読む */
export function createFirestoreRepo(db: Firestore, range: RangeKey = '10'): Repo {
  const byId = new Map<string, Item>();
  /** 読み込まずにいる「不要」の記事の目次（振り分けの保存・戻すときに使う） */
  const hiddenEntries = new Map<string, IndexEntry>();
  /** 不要にした記事も読み込むか（「不要」を開いたとき・検索するとき・点検画面） */
  let includeDropped = false;
  let reemit: (() => void) | null = null;
  /** saved にドキュメントがある記事（無い記事に削除を送らないため） */
  const savedIds = new Set<string>();

  /** 開いた記事の全データ（本文の冒頭・要約・キーワードなど）。一覧は目次だけで動くので、開いたときに読む */
  const fullCache = new Map<string, Article>();

  return {
    subscribe(onData, onError) {
      const since = rangeStart(range);
      /** 目次ドキュメントごとの目次（新しい順）と、作った記事（変わったドキュメントだけ作り直す） */
      const dayEntries = new Map<string, [string, IndexEntry][]>();
      const dayItems = new Map<string, Map<string, Item>>();
      let dayDecisions = new Map<string, Record<string, Decision>>();
      let saved = new Map<string, SavedDoc>();
      const ready = { days: false, decisions: false, saved: false };

      const emit = () => {
        if (!ready.days || !ready.decisions || !ready.saved) return;
        byId.clear();
        hiddenEntries.clear();
        const decisions: Record<string, Decision> = {};
        for (const [id, sd] of saved) decisions[id] = sd.decision;
        for (const m of dayDecisions.values()) Object.assign(decisions, m);
        // 目次ドキュメントのIDは時間順に並ぶので、新しいドキュメントから順に並べれば全体も新しい順になる。
        // 「不要」にした記事は、必要になるまで記事を作らない（件数が増えても軽く動くように）
        const items: Item[] = [];
        let hiddenDrops = 0;
        for (const k of [...dayEntries.keys()].sort().reverse()) {
          const made = dayItems.get(k) ?? new Map<string, Item>();
          dayItems.set(k, made);
          for (const [id, e] of dayEntries.get(k)!) {
            if (byId.has(id) || hiddenEntries.has(id)) continue;
            if (!includeDropped && decisions[id]?.status === 'drop') {
              hiddenEntries.set(id, e);
              hiddenDrops++;
              continue;
            }
            let it = made.get(id);
            if (!it) {
              it = toItem(fromEntry(id, e));
              made.set(id, it);
            }
            byId.set(id, it);
            items.push(it);
          }
        }
        let extra = false;
        for (const [id, sd] of saved) {
          if (!byId.has(id)) {
            const it = toItem(sd.article);
            byId.set(id, it);
            items.push(it);
            extra = true;
          }
        }
        if (extra) items.sort((x, y) => y.ts - x.ts);
        onData({ items, decisions, hiddenDrops });
      };
      const fail = (e: Error) => onError(e);
      reemit = emit;
      let older: ReturnType<typeof setTimeout> | undefined;

      /** 目次の購読（変わったドキュメントだけ作り直す）。first: 最初の結果が届いたら呼ぶ */
      const watchDays = (q: Query, first?: () => void) => {
        let got = false;
        return onSnapshot(
          q,
          // キャッシュ→サーバーの切り替わり（件数が同じでも）を受け取るため
          { includeMetadataChanges: true },
          (snap) => {
            // 端末内のキャッシュが空のときは、サーバーの結果を待つ（一瞬「0件」と出さない）
            if (snap.metadata.fromCache && snap.empty) return;
            const changes = snap.docChanges();
            // 中身が変わっていない通知（キャッシュ→サーバーの確認だけ）は、作り直さない
            if (!changes.length && got) return;
            for (const c of changes) {
              dayItems.delete(c.doc.id);
              if (c.type === 'removed') {
                dayEntries.delete(c.doc.id);
                continue;
              }
              const entries = Object.entries((c.doc.data().items ?? {}) as Record<string, IndexEntry>);
              entries.sort((x, y) => (x[1].p < y[1].p ? 1 : x[1].p > y[1].p ? -1 : 0));
              dayEntries.set(c.doc.id, entries);
            }
            if (!got) {
              got = true;
              first?.();
            }
            emit();
          },
          fail,
        );
      };
      // 全期間は記事が多い（9月1日から約11万件）。先に直近7日分を読んで画面を出し、古い分は少し待ってから読み足す
      // （同時に読むと、端末内の保存場所の読み込みが重なって最初の表示が遅れる）
      const recentKey = jstKey((since ?? Date.now() - 7 * 86400e3), 8);
      const unsubs = [
        watchDays(query(collection(db, 'days'), where(documentId(), '>=', recentKey)), () => {
          ready.days = true;
          if (since === null && !older)
            older = setTimeout(() => unsubs.push(watchDays(query(collection(db, 'days'), where(documentId(), '<', recentKey)))), 1500);
        }),
        onSnapshot(
          since === null
            ? collection(db, 'decisions')
            : query(collection(db, 'decisions'), where(documentId(), '>=', jstKey(since, 8))),
          // キャッシュ→サーバーの切り替わり（件数が同じでも）を受け取るため
          { includeMetadataChanges: true },
          (snap) => {
            // 0件は普通にある。キャッシュの0件も受け取る（オフラインで開いたとき止まらないように）。
            // 一度も同期していない端末では、SDK がサーバーの結果を待ってから届けるので「0件」は一瞬も出ない
            if (!snap.docChanges().length && ready.decisions) return;
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
            // 0件は普通にある（「読む」「読了」が空）。キャッシュの0件も受け取る（上と同じ理由）
            if (!snap.docChanges().length && ready.saved) return;
            saved = new Map(snap.docs.map((d) => [d.id, d.data() as SavedDoc]));
            savedIds.clear();
            for (const id of saved.keys()) savedIds.add(id);
            ready.saved = true;
            emit();
          },
          fail,
        ),
      ];
      return () => {
        reemit = null;
        clearTimeout(older);
        unsubs.forEach((u) => u());
      };
    },

    async loadArticle(id, publishedAt) {
      const hit = fullCache.get(id);
      if (hit) return hit;
      // 記事本体は buckets/{JSTのYYYYMMDDHH}（多い時間は _2, _3… に続く）にある
      const key = jstKey(new Date(publishedAt).getTime(), 10);
      const snap = await getDocs(
        query(collection(db, 'buckets'), where(documentId(), '>=', key), where(documentId(), '<', key + '`')),
      );
      for (const d of snap.docs) {
        const a = (d.data().items ?? {})[id] as Article | undefined;
        if (a) {
          fullCache.set(id, a);
          return a;
        }
      }
      return null;
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

    subscribeRuleReports(onData) {
      // 1週に1件しか増えないので、すべて読んで新しい順に並べる
      return onSnapshot(
        collection(db, 'ruleReports'),
        (snap) =>
          onData(
            snap.docs
              .map((d) => d.data() as RuleReport)
              .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
              .slice(0, 8),
          ),
        (e) => {
          console.error('ruleReports', e);
          onData([]);
        },
      );
    },
    subscribeConfig(onData) {
      return onSnapshot(
        doc(db, 'config', 'exclusion'),
        (d) => onData({ disabledRules: [], ...((d.data() ?? {}) as Partial<ExclusionConfig>) }),
        () => onData({ disabledRules: [] }),
      );
    },
    async saveConfig(c) {
      await setDoc(doc(db, 'config', 'exclusion'), c, { merge: true });
    },

    setIncludeDropped(on) {
      if (includeDropped === on) return;
      includeDropped = on;
      reemit?.();
    },

    async saveDecisions(changes) {
      // decisions/{記事の配信日} にまとめて書く。「読む」「読了」は記事ごと saved にも残す（無期限）
      const ops: ((b: WriteBatch) => void)[] = [];
      const perDay = new Map<string, Record<string, Decision | ReturnType<typeof deleteField>>>();
      for (const [id, d] of Object.entries(changes)) {
        const hidden = hiddenEntries.get(id);
        const it = byId.get(id) ?? (hidden ? toItem(fromEntry(id, hidden)) : undefined);
        if (!it) continue;
        const day = jstKey(it.ts, 8);
        const m = perDay.get(day) ?? {};
        // merge で書くので、消した項目（理由など）は明示的に削除する
        m[id] = d
          ? ({ ...d, reason: d.reason ?? deleteField(), reasonTags: d.reasonTags ?? deleteField() } as unknown as Decision)
          : deleteField();
        perDay.set(day, m);
        const savedRef = doc(db, 'saved', id);
        if (d && (d.status === 'keep' || d.status === 'done')) {
          const { ts: _ts, judge: _judge, rules: _rules, ...compact } = it;
          void _ts;
          void _judge;
          void _rules;
          const article = fullCache.get(id) ?? compact;
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
      // 書き込みが届いてから：「読む」は AI の下書きを頼み、「読了」は Knowledge Base への受け渡しを書き直す
      // （どちらも、届かなかったときは Cloud Functions の予備の処理が拾う）
      const moved = Object.entries(changes).filter(([, d]) => d && (d.status === 'keep' || d.status === 'done'));
      if (moved.length && moved.length <= 20) {
        for (const [id, d] of moved) void (d!.status === 'keep' ? requestDraft(id) : refreshHandoff(id));
      }
    },
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiStatus, Decision, Item, Status, TagKey } from '../types';
import type { Repo } from '../data/repo';

export type TagFilter = 'all' | 'other' | TagKey;

/** AIの判定から決まる初期の振り分け先 */
export function defaultStatus(it: Item): Status {
  if (it.judge.autoExclude) return 'drop';
  return it.judge.score === 'high' ? 'inbox' : it.judge.score === 'mid' ? 'cand' : 'drop';
}

export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
}

const LABEL: Record<Status, string> = {
  keep: '「読む」に入れました',
  drop: '不要にしました',
  done: '既読にしました',
  inbox: '受信箱に戻しました',
  cand: '候補に戻しました',
};

export function useTriage(repo: Repo) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [dec, setDec] = useState<Record<string, Decision>>({});
  const [view, setView] = useState<Status>('inbox');
  const [tag, setTag] = useState<TagFilter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastSeq = useRef(0);

  const [error, setError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  useEffect(() => repo.subscribeAiStatus?.(setAiStatus), [repo]);
  useEffect(() => {
    setLoading(true);
    return repo.subscribe(
      ({ items: its, decisions }) => {
        setItems(its);
        setDec(decisions);
        setLoading(false);
        setError(null);
      },
      (e) => {
        setError(e.message);
        setLoading(false);
      },
    );
  }, [repo]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const statusOf = useCallback((it: Item) => dec[it.id]?.status ?? defaultStatus(it), [dec]);

  // 件数集計と表示対象を1回の走査で作る（3,000件/日×数日でも軽く）
  const derived = useMemo(() => {
    const counts: Record<Status, number> = { inbox: 0, cand: 0, keep: 0, done: 0, drop: 0 };
    const tagCounts: Record<string, number> = { all: 0, other: 0, fund: 0, ipo: 0, ma: 0, new: 0, mkt: 0 };
    const visible: Item[] = [];
    const needle = q.trim().toLowerCase();
    for (const it of items) {
      const st = statusOf(it);
      counts[st]++;
      if (st !== view) continue;
      if (needle && !(it.title + ' ' + it.company).toLowerCase().includes(needle)) continue;
      tagCounts.all++;
      if (!it.judge.tags.length) tagCounts.other++;
      for (const t of it.judge.tags) tagCounts[t]++;
      const ok = tag === 'all' || (tag === 'other' ? it.judge.tags.length === 0 : it.judge.tags.includes(tag));
      if (ok) visible.push(it);
    }
    return { counts, tagCounts, visible };
  }, [items, statusOf, view, q, tag]);

  const learning = useMemo(() => {
    let manualDrop = 0;
    let picked = 0;
    for (const [id, d] of Object.entries(dec)) {
      const it = byId.get(id);
      if (!it) continue;
      if (d.status === 'drop' && d.how === 'manual') manualDrop++;
      if ((d.status === 'keep' || d.status === 'done') && it.judge.score !== 'high') picked++;
    }
    return { manualDrop, picked };
  }, [dec, byId]);

  const showToast = useCallback((text: string, undo?: () => void) => {
    toastSeq.current++;
    setToast({ id: toastSeq.current, text, undo });
  }, []);

  /** 振り分けを適用し、元に戻す関数を返す */
  const apply = useCallback(
    (changes: Record<string, Decision | null>) => {
      const prev: Record<string, Decision | null> = {};
      setDec((cur) => {
        const next = { ...cur };
        for (const [id, d] of Object.entries(changes)) {
          prev[id] = cur[id] ?? null;
          if (d) next[id] = d;
          else delete next[id];
        }
        return next;
      });
      void repo.saveDecisions(changes);
      return () => {
        setDec((cur) => {
          const next = { ...cur };
          for (const [id, d] of Object.entries(prev)) {
            if (d) next[id] = d;
            else delete next[id];
          }
          return next;
        });
        void repo.saveDecisions(prev);
      };
    },
    [repo],
  );

  const setStatus = useCallback(
    (id: string, status: Status) => {
      const it = byId.get(id);
      if (!it) return;
      // AIの初期判定と同じ場所に戻す場合は記録を消す
      const change: Decision | null =
        status === defaultStatus(it)
          ? null
          : { status, how: 'manual', at: Date.now(), title: it.title, company: it.company, aiScore: it.judge.score };
      const undo = apply({ [id]: change });
      showToast(LABEL[status], undo);
    },
    [byId, apply, showToast],
  );

  const bulkDrop = useCallback(
    (targets: Item[]) => {
      const at = Date.now();
      const changes: Record<string, Decision> = {};
      for (const it of targets) changes[it.id] = { status: 'drop', how: 'bulk', at };
      const undo = apply(changes);
      setSel(null);
      showToast(`${targets.length.toLocaleString('ja-JP')}件を不要にしました（学習には弱めに反映）`, undo);
    },
    [apply, showToast],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  return {
    loading,
    error,
    aiStatus,
    items,
    byId,
    statusOf,
    /** ユーザーが振り分けた記事か（AIの初期判定のままなら false） */
    decided: (id: string) => id in dec,
    view,
    setView: (v: Status) => {
      setView(v);
      setTag('all');
      setSel(null);
    },
    tag,
    setTag,
    q,
    setQ,
    sel,
    setSel,
    ...derived,
    learning,
    setStatus,
    bulkDrop,
    toast,
    dismissToast,
  };
}

export type Triage = ReturnType<typeof useTriage>;

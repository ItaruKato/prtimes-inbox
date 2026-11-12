import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiStatus, Decision, ExclusionConfig, Item, RuleReport, Status, TagKey } from '../types';
import { EXCLUSION_RULES } from '../lib/exclusion';
import type { Repo } from '../data/repo';
import { AI_SCORING } from '../lib/flags';

export type TagFilter = 'all' | 'other' | TagKey;

/** 当てはまる自動除外ルールのうち、オンになっている最初のもの */
export function activeRule(it: Item, disabled: ReadonlySet<string>): string | undefined {
  return it.rules.find((id) => !disabled.has(id));
}

/** 初期の振り分け先（自動除外ルール・AIの判定から決まる） */
export function defaultStatus(it: Item, disabled: ReadonlySet<string> = new Set()): Status {
  const rule = activeRule(it, disabled);
  if (!AI_SCORING) return rule ? 'drop' : 'inbox';
  if (rule || it.judge.autoExclude) return 'drop';
  return it.judge.score === 'high' ? 'inbox' : it.judge.score === 'mid' ? 'cand' : 'drop';
}

/** 起動直後に出す「前回の受信箱」（端末に保存。最新を読み込むまでのつなぎ） */
export interface Preview {
  savedAt: number;
  rows: { id: string; t: string; c: string; ts: number; g: TagKey[] }[];
  counts: Record<Status, number>;
}
const PREVIEW_KEY = 'prt-preview-v1';
function loadPreview(): Preview | null {
  try {
    const p = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null') as Preview | null;
    return p && Array.isArray(p.rows) ? p : null;
  } catch {
    return null;
  }
}

export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  /** 「理由を書く」など、もう1つの操作 */
  action?: { label: string; run: () => void };
}

const LABEL: Record<Status, string> = {
  keep: '「読む」に入れました',
  drop: '不要にしました',
  done: '読了にしました（Knowledge Base に渡します）',
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
  const [preview] = useState<Preview | null>(loadPreview);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  useEffect(() => repo.subscribeAiStatus?.(setAiStatus), [repo]);
  const [config, setConfig] = useState<ExclusionConfig>({ disabledRules: [] });
  useEffect(() => repo.subscribeConfig((c) => setConfig(c)), [repo]);
  const disabled = useMemo(() => new Set(config.disabledRules), [config]);
  const [reports, setReports] = useState<RuleReport[]>([]);
  useEffect(() => repo.subscribeRuleReports(setReports), [repo]);
  /** 表示中の画面（振り分け／ルールの点検） */
  // 起動時は「判定」から始める
  const [page, setPage] = useState<'triage' | 'review' | 'judge'>('judge');
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
  const statusOf = useCallback((it: Item) => dec[it.id]?.status ?? defaultStatus(it, disabled), [dec, disabled]);

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

  // 次に開いたときすぐ出せるよう、受信箱の先頭と件数を端末に保存する（少し待ってから）
  useEffect(() => {
    if (loading || !items.length) return;
    const id = setTimeout(() => {
      const rows: Preview['rows'] = [];
      for (const it of items) {
        if (rows.length >= 120) break;
        if ((dec[it.id]?.status ?? defaultStatus(it, disabled)) !== 'inbox') continue;
        rows.push({ id: it.id, t: it.title, c: it.company, ts: it.ts, g: it.judge.tags });
      }
      try {
        localStorage.setItem(PREVIEW_KEY, JSON.stringify({ savedAt: Date.now(), rows, counts: derived.counts }));
      } catch {
        /* 保存できなくても動く */
      }
    }, 1500);
    return () => clearTimeout(id);
  }, [loading, items, dec, disabled, derived.counts]);

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

  /** ルールごとの件数：当てはまる記事、そのうち受信箱などに戻した記事（ルールが外れていた候補） */
  const ruleStats = useMemo(() => {
    const m: Record<string, { matched: number; restored: number }> = {};
    for (const r of EXCLUSION_RULES) m[r.id] = { matched: 0, restored: 0 };
    for (const it of items)
      for (const id of it.rules) {
        const s = m[id];
        if (!s) continue;
        s.matched++;
        const d = dec[it.id];
        if (d && d.how === 'manual' && d.status !== 'drop') s.restored++;
      }
    return m;
  }, [items, dec]);

  const reasonCount = useMemo(
    () => Object.values(dec).filter((d) => d.status === 'drop' && d.how === 'manual' && (d.reason || d.reasonTags?.length)).length,
    [dec],
  );

  const showToast = useCallback((text: string, undo?: () => void, action?: Toast['action']) => {
    toastSeq.current++;
    setToast({ id: toastSeq.current, text, undo, action });
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

  /**
   * 振り分ける。元に戻す関数を返す。
   * opts.reasonTags: 不要の理由（判定画面で選んだもの）／ opts.quiet: 通知を出さない（判定画面は自分で出す）
   */
  const setStatus = useCallback(
    (id: string, status: Status, opts: { reasonTags?: string[]; quiet?: boolean } = {}): (() => void) | undefined => {
      const it = byId.get(id);
      if (!it) return undefined;
      // AIの初期判定と同じ場所に戻す場合は記録を消す
      const prev = dec[it.id];
      const change: Decision | null =
        status === defaultStatus(it, disabled)
          ? null
          : {
              status,
              how: 'manual',
              at: Date.now(),
              title: it.title,
              company: it.company,
              aiScore: it.judge.score,
              ...(it.rules.length ? { ruleIds: it.rules } : {}),
              // 不要のまま操作し直したときは、書いた理由を残す
              ...(status === 'drop' && prev?.reason ? { reason: prev.reason } : {}),
              ...(status === 'drop' && prev?.reasonTags?.length ? { reasonTags: prev.reasonTags } : {}),
              ...(status === 'drop' && opts.reasonTags?.length ? { reasonTags: opts.reasonTags } : {}),
            };
      const undo = apply({ [id]: change });
      if (!opts.quiet)
        showToast(
          LABEL[status],
          undo,
          status === 'drop' ? { label: '理由を書く', run: () => setSel(id) } : undefined,
        );
      return undo;
    },
    [byId, dec, disabled, apply, showToast],
  );

  /** 不要にした理由を記録する（ルールで自動除外された記事に書いた場合も、手動の「不要」として残す） */
  const setReason = useCallback(
    (id: string, reason: string, reasonTags: string[]) => {
      const it = byId.get(id);
      if (!it) return;
      const prev = dec[id];
      const base: Decision =
        prev && prev.status === 'drop'
          ? prev
          : { status: 'drop', how: 'manual', at: Date.now(), title: it.title, company: it.company, aiScore: it.judge.score, ...(it.rules.length ? { ruleIds: it.rules } : {}) };
      const next: Decision = { ...base, how: 'manual', title: it.title, company: it.company };
      const text = reason.trim();
      if (text) next.reason = text.slice(0, 500);
      else delete next.reason;
      if (reasonTags.length) next.reasonTags = reasonTags;
      else delete next.reasonTags;
      apply({ [id]: next });
      showToast('理由を保存しました');
    },
    [byId, dec, apply, showToast],
  );

  const setRuleEnabled = useCallback(
    (id: string, enabled: boolean) => {
      const set = new Set(config.disabledRules);
      if (enabled) set.delete(id);
      else set.add(id);
      const next = { ...config, disabledRules: [...set] };
      setConfig(next);
      void repo.saveConfig(next);
      showToast(enabled ? 'ルールをオンにしました' : 'ルールをオフにしました（当てはまる記事は受信箱に入ります）');
    },
    [config, repo, showToast],
  );

  const markReviewed = useCallback(() => {
    const next = { ...config, lastReviewedAt: new Date().toISOString() };
    setConfig(next);
    void repo.saveConfig(next);
    showToast('点検済みにしました');
  }, [config, repo, showToast]);

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
    decisionOf: (id: string) => dec[id],
    /** 記事の全データを読む（一覧は目次だけなので、詳細を開いたときに使う） */
    loadArticle: repo.loadArticle ? (it: Item) => repo.loadArticle!(it.id, it.publishedAt) : undefined,
    disabledRules: disabled,
    ruleStats,
    reasonCount,
    setReason,
    setRuleEnabled,
    reports,
    lastReviewedAt: config.lastReviewedAt,
    markReviewed,
    page,
    setPage,
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
    // 読み込み中は、前回保存した件数を出す（0件が並ばないように）
    counts: loading && preview ? preview.counts : derived.counts,
    preview: loading ? preview : null,
    learning,
    setStatus,
    bulkDrop,
    toast,
    dismissToast,
  };
}

export type Triage = ReturnType<typeof useTriage>;

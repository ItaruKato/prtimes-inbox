import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { createMockRepo } from './data/mockRepo';
import { createFirestoreRepo } from './data/firestoreRepo';
import { loadRange, rangeLabel, saveRange, type RangeKey } from './lib/range';
import type { Repo } from './data/repo';
import { firebaseEnabled, getFirebase, OWNER_EMAIL } from './firebase';
import { Login } from './components/Login';
import { useTriage } from './state/useTriage';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ArticleList } from './components/ArticleList';
import { DetailPane } from './components/DetailPane';
import { TabBar } from './components/TabBar';
import { ToastView } from './components/ToastView';
import { JudgePage } from './components/JudgePage';
const ReviewPage = lazy(() => import('./components/ReviewPage').then((m) => ({ default: m.ReviewPage })));

// ?stress=1 で 3,000件/日×2日 の負荷テスト用データ
const stress = new URLSearchParams(location.search).has('stress');

export default function App() {
  return firebaseEnabled ? <WithFirebase /> : <MockApp />;
}

function MockApp() {
  const repo = useMemo(() => createMockRepo({ stress }), []);
  return <Inbox repo={repo} source={(n) => `試作データ ${n}件${stress ? '（負荷テスト）' : ''}`} />;
}

function WithFirebase() {
  const { auth, db } = getFirebase();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), [auth]);
  const ok = user && user.email === OWNER_EMAIL && user.emailVerified;
  const [range, setRange] = useState<RangeKey>(loadRange);
  const repo = useMemo(() => (ok ? createFirestoreRepo(db, range) : null), [ok, db, range]);
  if (user === undefined) return <div className="login"><div className="logincard">読み込み中…</div></div>;
  if (!ok || !repo) return <Login auth={auth} wrongUser={user} />;
  return (
    <Inbox
      repo={repo}
      source={(n) => `${rangeLabel(range)} ＋ 読む・読了 ${n}件`}
      onSignOut={() => signOut(auth)}
      range={range}
      onRange={(k) => {
        saveRange(k);
        setRange(k);
      }}
    />
  );
}

function Inbox({
  repo,
  source,
  onSignOut,
  range,
  onRange,
}: {
  repo: Repo;
  source: (n: string) => string;
  onSignOut?: () => void;
  range?: RangeKey;
  onRange?: (k: RangeKey) => void;
}) {
  const t = useTriage(repo);

  // キーボード操作（Windows / Mac）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      // 判定・点検の画面では、それぞれの画面のキー操作を使う
      if (t.page !== 'triage') return;
      const v = t.visible;
      const i = v.findIndex((x) => x.id === t.sel);
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        const n = k === 'j' ? Math.min(v.length - 1, i + 1) : Math.max(0, i - 1);
        if (v[n]) t.setSel(v[n].id);
        e.preventDefault();
      } else if (t.sel && (k === 'r' || k === 'x' || k === 'e')) {
        const next = v[i + 1] ?? v[i - 1];
        const st = k === 'r' ? 'keep' : k === 'x' ? 'drop' : 'done';
        t.setStatus(t.sel, st);
        if (st !== t.view) t.setSel(next?.id ?? null);
      } else if (t.sel && k === 'o') {
        const it = t.byId.get(t.sel);
        if (it) window.open(it.url, '_blank', 'noopener');
      } else if (k === 'escape') t.setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t]);

  const dataLabel = t.error ? `読み込みエラー：${t.error}` : t.loading ? '読み込み中…' : source(t.items.length.toLocaleString('ja-JP'));

  return (
    <div className={t.page === 'triage' ? 'app' : 'app reviewing'}>
      <Sidebar t={t} dataLabel={dataLabel} onSignOut={onSignOut} />
      <section className="main">
        {t.page === 'judge' ? (
          <JudgePage t={t} range={range} onRange={onRange} />
        ) : t.page === 'review' ? (
          <Suspense fallback={<div className="empty">読み込み中…</div>}>
            <ReviewPage t={t} />
          </Suspense>
        ) : (
          <>
            <TopBar t={t} range={range} onRange={onRange} />
            <ArticleList t={t} />
          </>
        )}
        <TabBar t={t} />
      </section>
      {t.page === 'triage' && <DetailPane t={t} />}
      <ToastView toast={t.toast} onClose={t.dismissToast} />
    </div>
  );
}

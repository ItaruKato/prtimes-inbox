import { useEffect, useMemo } from 'react';
import { createMockRepo } from './data/mockRepo';
import { useTriage } from './state/useTriage';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ArticleList } from './components/ArticleList';
import { DetailPane } from './components/DetailPane';
import { TabBar } from './components/TabBar';
import { ToastView } from './components/ToastView';

// ?stress=1 で 3,000件/日×2日 の負荷テスト用データ
const stress = new URLSearchParams(location.search).has('stress');

export default function App() {
  const repo = useMemo(() => createMockRepo({ stress }), []);
  const t = useTriage(repo);

  // キーボード操作（Windows / Mac）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
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

  const dataLabel = t.loading ? '読み込み中…' : `試作データ ${t.items.length.toLocaleString('ja-JP')}件${stress ? '（負荷テスト）' : ''}`;

  return (
    <div className="app">
      <Sidebar t={t} dataLabel={dataLabel} />
      <section className="main">
        <TopBar t={t} />
        <ArticleList t={t} />
        <TabBar t={t} />
      </section>
      <DetailPane t={t} />
      <ToastView toast={t.toast} onClose={t.dismissToast} />
    </div>
  );
}

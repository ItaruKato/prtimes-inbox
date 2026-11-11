import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Item, Status } from '../types';
import type { Triage } from '../state/useTriage';
import { dayKey, num } from '../lib/format';
import { ArticleRow } from './ArticleRow';
import { AI_SCORING } from '../lib/flags';
import { activeRule } from '../state/useTriage';
import { ruleLabel } from '../lib/exclusion';
import { RulesPanel } from './RulesPanel';
import { NotifyBox } from './NotifyBox';

const PAGE = 150;

const EMPTY: Record<Status, [string, string]> = {
  inbox: ['受信箱は空です', AI_SCORING ? 'おすすめ度「高」の新着が1時間ごとに届きます' : '新着が1時間ごとに届きます'],
  cand: ['候補はありません', 'おすすめ度「中」の記事がここに入ります'],
  keep: ['「読む」に入れた記事はありません', '受信箱で「読む」を押すとここに入ります'],
  done: ['既読の記事はありません', '読み終えた記事がここにたまります'],
  drop: ['不要な記事はありません', ''],
};

export function ArticleList({ t }: { t: Triage }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(PAGE);
  const { visible, view, tag, q, sel } = t;

  // 表示条件が変わったら先頭から
  useEffect(() => {
    setShown(PAGE);
    listRef.current?.scrollTo({ top: 0 });
  }, [view, tag, q]);

  // キーボードで先まで進んだら読み込みを広げる
  useEffect(() => {
    if (!sel) return;
    const i = visible.findIndex((x) => x.id === sel);
    if (i >= shown - 1) setShown(i + PAGE);
    listRef.current?.querySelector(`.row[data-id="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, visible, shown]);

  const onScroll = () => {
    const l = listRef.current;
    if (l && l.scrollTop + l.clientHeight > l.scrollHeight - 800 && shown < visible.length) setShown((s) => s + PAGE);
  };

  const dayCounts = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of visible) {
      const k = dayKey(it.ts);
      const arr = m.get(k);
      if (arr) arr.push(it);
      else m.set(k, [it]);
    }
    return m;
  }, [visible]);

  if (t.loading) return <div className="list"><div className="empty">読み込み中…</div></div>;
  // スマホでは左の欄（エラー表示）が出ないので、一覧にも出す
  if (t.error && !t.items.length)
    return <div className="list"><div className="empty"><b>読み込めませんでした</b>{t.error}</div></div>;
  if (!visible.length) {
    const [a, b] = EMPTY[view];
    return (
      <div className="list">
        {view === 'drop' && (
          <div className="rulesinline">
            <RulesPanel t={t} compact />
          </div>
        )}
        <div className="empty"><b>{a}</b>{b}</div>
      </div>
    );
  }

  const triageView = view === 'inbox' || view === 'cand';
  let cur = '';
  return (
    <div className="list" ref={listRef} onScroll={onScroll}>
      {view === 'inbox' && (
        <div className="rulesinline phoneonly">
          <NotifyBox banner />
        </div>
      )}
      {view === 'drop' && (
        <div className="rulesinline">
          <RulesPanel t={t} compact />
        </div>
      )}
      {visible.slice(0, shown).map((it) => {
        const k = dayKey(it.ts);
        const head = k !== cur;
        cur = k;
        const st = t.statusOf(it);
        const note =
          st === 'drop' && !t.decided(it.id)
            ? activeRule(it, t.disabledRules)
              ? `自動除外：${ruleLabel(activeRule(it, t.disabledRules)!)}`
              : AI_SCORING && it.judge.autoExclude
                ? `自動除外：${it.judge.autoExclude}`
                : AI_SCORING && it.judge.score === 'low'
                  ? 'AI判定：低'
                  : ''
            : '';
        return (
          <Fragment key={it.id}>
            {head && (
              <div className="day">
                {k}
                <span>
                  {num(dayCounts.get(k)!.length)}件
                  {triageView && (
                    <>
                      {' ・ '}
                      <button className="bulk" type="button" onClick={() => t.bulkDrop(dayCounts.get(k)!)}>
                        この日を全部不要
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}
            <ArticleRow it={it} st={st} selected={sel === it.id} autoNote={note} onOpen={t.setSel} onAct={t.setStatus} />
          </Fragment>
        );
      })}
      {shown < visible.length && <div className="more">残り {num(visible.length - shown)}件を読み込み中…</div>}
    </div>
  );
}

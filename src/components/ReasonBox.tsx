import { useEffect, useState } from 'react';
import type { Item } from '../types';
import type { Triage } from '../state/useTriage';
import { REASON_PRESETS, ruleLabel } from '../lib/exclusion';

/** 不要にした理由を書く欄（詳細画面） */
export function ReasonBox({ t, it }: { t: Triage; it: Item }) {
  const d = t.decisionOf(it.id);
  const [tags, setTags] = useState<string[]>(d?.reasonTags ?? []);
  const [text, setText] = useState(d?.reason ?? '');
  // 別の記事を開いたら、その記事の内容に入れ替える
  useEffect(() => {
    setTags(d?.reasonTags ?? []);
    setText(d?.reason ?? '');
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = (d?.reason ?? '') === text.trim() && sameSet(d?.reasonTags ?? [], tags);
  const auto: string[] = d ? [] : it.rules.filter((id) => !t.disabledRules.has(id));
  const toggle = (p: string) => setTags((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <div className="reasonbox">
      <b>不要にした理由</b>
      {auto.length > 0 && (
        <p className="muted small">
          「{auto.map(ruleLabel).join('・')}」のルールで自動で除外しました。読みたい記事なら「受信箱に戻す」を押してください（ルールを見直す材料になります）。
        </p>
      )}
      <div className="reasonchips" role="group" aria-label="理由を選ぶ">
        {REASON_PRESETS.map((p) => (
          <button key={p} type="button" className="chip" aria-pressed={tags.includes(p)} onClick={() => toggle(p)}>
            {p}
          </button>
        ))}
      </div>
      <textarea
        id={`reason-${it.id}`}
        className="reasontext"
        rows={2}
        maxLength={500}
        placeholder="例：一般消費者向けのセールで、事業の参考にならない"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="reasonacts">
        <button className="btn" type="button" disabled={saved} onClick={() => t.setReason(it.id, text, tags)}>
          {saved && (d?.reason || d?.reasonTags?.length) ? '保存済み' : '理由を保存'}
        </button>
        <span className="muted small">書いた理由をもとに、自動で除外するルールを見直します</span>
      </div>
    </div>
  );
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

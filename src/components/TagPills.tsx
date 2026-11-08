import type { Item } from '../types';
import { tagLabel } from '../lib/tags';

export function TagPills({ it }: { it: Item }) {
  return (
    <>
      {it.judge.tags.map((k) => (
        <span key={k} className={`tag ${k}`}>
          {tagLabel(k)}
        </span>
      ))}
      {it.game && <span className="tag game">ゲーム</span>}
    </>
  );
}

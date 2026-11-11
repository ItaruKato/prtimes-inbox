import type { Score, Status, TagKey } from '../types';
import { AI_SCORING } from './flags';

export const TAGS: { k: TagKey; label: string }[] = [
  { k: 'fund', label: '資金調達' },
  { k: 'ipo', label: '上場' },
  { k: 'ma', label: 'M&A' },
  { k: 'new', label: '新規事業' },
  { k: 'mkt', label: 'マーケ' },
];
export const tagLabel = (k: TagKey) => TAGS.find((t) => t.k === k)!.label;

export const VIEWS: { k: Status; label: string; note?: string }[] = AI_SCORING
  ? [
      { k: 'inbox', label: '受信箱', note: 'おすすめ度 高' },
      { k: 'cand', label: '候補', note: 'おすすめ度 中' },
      { k: 'keep', label: '読む' },
      { k: 'done', label: '既読' },
      { k: 'drop', label: '不要' },
    ]
  : [
      { k: 'inbox', label: '受信箱', note: '自動除外以外すべて' },
      { k: 'keep', label: '読む' },
      { k: 'done', label: '既読' },
      { k: 'drop', label: '不要' },
    ];

export const SCORE_LABEL: Record<Score, string> = { high: '高', mid: '中', low: '低' };

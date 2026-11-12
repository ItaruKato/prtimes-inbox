/** 画面に読み込む期間（「読む」「読了」に入れた記事は期間に関係なくすべて表示する） */
export type RangeKey = '3' | '7' | '10' | 'all';

export const RANGES: { k: RangeKey; label: string }[] = [
  { k: '3', label: '直近3日' },
  { k: '7', label: '直近7日' },
  { k: '10', label: '直近10日' },
  { k: 'all', label: '10/1から' },
];

export const rangeLabel = (k: RangeKey) => RANGES.find((r) => r.k === k)!.label;

// 判定の対象を10月1日からに広げたときに既定値を「全期間」に変えたので、記憶する場所も新しくした
const LS_KEY = 'prt-range-v2';

/** 前回選んだ期間（端末に記憶）。読めなければ全期間（10月1日から） */
export function loadRange(): RangeKey {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v && RANGES.some((r) => r.k === v)) return v as RangeKey;
  } catch {
    /* 保存できない環境では既定値 */
  }
  return 'all';
}

export function saveRange(k: RangeKey) {
  try {
    localStorage.setItem(LS_KEY, k);
  } catch {
    /* 保存できない環境では記憶しない */
  }
}

/** 読み込み開始日時（ミリ秒）。全期間なら null */
export const rangeStart = (k: RangeKey, now = Date.now()): number | null =>
  k === 'all' ? null : now - Number(k) * 86400e3;

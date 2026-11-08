/** モデルごとの料金（米ドル / 100万トークン）。cacheRead はキャッシュから読んだ入力 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  // 要約が拒否されたときの代替モデル（念のため Opus 相当で計算）
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
};
const FALLBACK = { input: 5, output: 25, cacheRead: 0.5 };

export interface UsageTotals {
  input?: number;
  output?: number;
  cacheRead?: number;
}

/** aiUsage/{日} のドキュメント（モデル名 → 利用量）から費用を出す */
export function costUsd(day: Record<string, UsageTotals>): number {
  let usd = 0;
  for (const [model, u] of Object.entries(day)) {
    const p = PRICES[model] ?? FALLBACK;
    usd += ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cacheRead ?? 0) * p.cacheRead) / 1e6;
  }
  return usd;
}

export const USD_JPY = 150;

import type { Decision, Item } from '../types';

/**
 * データの入出力。いまは試作データ（mockRepo）を使い、
 * Firebase の準備ができたら firestoreRepo に差し替える。
 */
export interface Repo {
  loadItems(): Promise<Item[]>;
  loadDecisions(): Promise<Record<string, Decision>>;
  /** null は「振り分けを取り消す（AIの初期判定に戻す）」 */
  saveDecisions(changes: Record<string, Decision | null>): Promise<void>;
}

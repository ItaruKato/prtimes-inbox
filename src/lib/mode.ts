import type { Article, Item } from '../types';
import { mockJudge } from './mockJudge';

export { AI_SCORING } from './flags';

/**
 * 新作ゲームの案内か（Claude の判定、またはキーワードによる判定のどちらかで該当）。
 * 保存済みのキーワード判定（by: rule-…）は古いルールの結果のことがあるので使わず、画面側で最新のルールで判定し直す。
 */
export const isGame = (a: Article): boolean =>
  (a.ai?.by?.startsWith('claude') === true && a.ai.autoExclude === '新作ゲーム') ||
  mockJudge(a).autoExclude === '新作ゲーム';

export const toItem = (a: Article): Item => ({
  ...a,
  ts: new Date(a.publishedAt).getTime(),
  judge: a.ai ?? mockJudge(a),
  game: isGame(a),
});

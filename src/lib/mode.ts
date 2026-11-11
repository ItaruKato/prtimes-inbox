import type { Article, Item } from '../types';
import { mockJudge } from './mockJudge';
import { matchRules } from './exclusion';

export { AI_SCORING } from './flags';
export { isGame } from './exclusion';

export const toItem = (a: Article): Item => ({
  ...a,
  ts: new Date(a.publishedAt).getTime(),
  judge: a.ai ?? mockJudge(a),
  rules: matchRules(a),
});

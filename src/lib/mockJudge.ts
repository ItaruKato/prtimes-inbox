import type { AiJudgement, Article, Score, TagKey } from '../types';
import { tagLabel } from './tags';

/**
 * 仮のAI判定（キーワード一致）。
 * 本番では取得処理（Cloud Functions）がClaudeで判定し、Article.ai に保存する。
 */
const RULES: { k: TagKey; re: RegExp }[] = [
  { k: 'fund', re: /資金調達|第三者割当|シリーズ[A-EＡ-Ｅ]|プレシリーズ|シードラウンド|ラウンド.{0,6}調達|億円を調達|万円を調達|出資を実施|出資を受け|増資|クラウドファンディング/ },
  { k: 'ipo', re: /(?<!非)上場|IPO|東証|グロース市場|プライム市場|スタンダード市場|新規公開/ },
  { k: 'ma', re: /M&A|Ｍ＆Ａ|買収|子会社化|株式取得|株式を取得|事業譲渡|事業承継|経営統合|合併|資本業務提携|資本提携|公開買付|TOB|グループ入り/ },
  { k: 'new', re: /新規事業|新事業|事業を開始|事業開始|参入|新会社|会社を設立|設立のお知らせ|立ち上げ|新ブランド|新サービス|提供開始|ローンチ/ },
  { k: 'mkt', re: /マーケティング|広告|販促|プロモーション|ブランディング|SNS|インフルエンサー|集客|CRM|リード獲得|D2C|PR戦略|調査レポート|意識調査|実態調査/ },
];
/**
 * 新作ゲームの案内か（タイトルで判定）。
 * 「ガチャ」「Switch」などの単語だけでは判定しない（飲食店のガチャ企画や、景品に Switch が当たるキャンペーンを誤って除外していたため）。
 */
const GAME_RE = new RegExp(
  [
    '新作ゲーム',
    'ゲームアプリ',
    'スマホゲーム',
    'ソーシャルゲーム',
    'ブラウザゲーム',
    '事前登録',
    '(?<![A-Za-z])(RPG|MMORPG|SLG)(?![A-Za-z])',
    'ゲーム[^。]{0,12}(配信|リリース|発売|アップデート|正式サービス|ダウンロード)',
    '(配信|リリース|発売|正式サービス)[^。]{0,12}ゲーム',
    '(Steam|Nintendo Switch|Switch 2|ニンテンドースイッチ|PS5|PS4|PlayStation|プレイステーション|Xbox)[^。]{0,15}(版|向け|ソフト|対応|配信|発売|リリース)',
    '(ゲーム|RPG)[^。]{0,40}ガチャ',
    'ピックアップガチャ',
  ].join('|'),
);
// 景品・プレゼントとしてゲーム機が出てくるだけの記事は除外しない
const PRIZE_RE = /当たる|プレゼント|抽選/;

const STRONG_RE = new RegExp(RULES.filter((r) => r.k === 'fund' || r.k === 'ipo' || r.k === 'ma').map((r) => r.re.source).join('|'));
const NEW_GAME_RE = /新作|配信開始|事前登録|リリース/;

/**
 * 新作ゲームの案内か（タイトル・キーワード・本文の冒頭で判定）。mockJudge と同じ結果を、少ない計算で出す。
 * 資金調達・上場・M&A に当たる記事は除外しない。
 */
export function isGameArticle(a: Pick<Article, 'title' | 'lead' | 'keywords'>): boolean {
  const titleGame = GAME_RE.test(a.title) && !(PRIZE_RE.test(a.title) && !NEW_GAME_RE.test(a.title));
  if (!titleGame && !a.keywords.some((k) => /ゲーム/.test(k))) return false;
  return !STRONG_RE.test(a.title + ' ' + a.lead.slice(0, 160));
}

export function mockJudge(a: Article): AiJudgement {
  const text = a.title + ' ' + a.lead.slice(0, 160);
  const tags = RULES.filter((r) => r.re.test(text)).map((r) => r.k);
  const strongTag = tags.find((t) => t === 'fund' || t === 'ipo' || t === 'ma');
  const softTag = tags.find((t) => t === 'new' || t === 'mkt');
  const titleGame = GAME_RE.test(a.title) && !(PRIZE_RE.test(a.title) && !/新作|配信開始|事前登録|リリース/.test(a.title));
  const isGame = (titleGame || a.keywords.some((k) => /ゲーム/.test(k))) && !strongTag;
  const mgmt = /経営情報/.test(a.section);

  let score: Score = 'low';
  let reason = '注目テーマに該当なし';
  if (strongTag) {
    score = 'high';
    reason = `${tagLabel(strongTag)}に該当`;
  } else if (softTag && (a.ticker || mgmt)) {
    score = 'high';
    reason = `上場企業・経営関連の${tagLabel(softTag)}`;
  } else if (softTag) {
    score = 'mid';
    reason = `${tagLabel(softTag)}の可能性`;
  } else if (a.ticker || mgmt || /提携|協業|共同開発|就任|設立/.test(a.title)) {
    score = 'mid';
    reason = a.ticker ? '上場企業の発表' : '提携・経営関連の可能性';
  }
  return { score, reason, tags, autoExclude: isGame ? '新作ゲーム' : undefined };
}

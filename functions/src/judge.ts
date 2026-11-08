import type { AiJudgement, Score, TagKey } from './types';

const LABEL: Record<TagKey, string> = { fund: '資金調達', ipo: '上場', ma: 'M&A', new: '新規事業', mkt: 'マーケ' };
const tagLabel = (k: TagKey) => LABEL[k];

interface JudgeInput {
  title: string;
  lead: string;
  keywords: string[];
  ticker: string;
  section: string;
}

/**
 * ルールによる判定（rule-v0）。Claude による判定を入れるまでの暫定。
 * 画面側の src/lib/mockJudge.ts と同じ内容。
 */
const RULES: { k: TagKey; re: RegExp }[] = [
  { k: 'fund', re: /資金調達|第三者割当|シリーズ[A-EＡ-Ｅ]|プレシリーズ|シードラウンド|ラウンド.{0,6}調達|億円を調達|万円を調達|出資を実施|出資を受け|増資|クラウドファンディング/ },
  { k: 'ipo', re: /(?<!非)上場|IPO|東証|グロース市場|プライム市場|スタンダード市場|新規公開/ },
  { k: 'ma', re: /M&A|Ｍ＆Ａ|買収|子会社化|株式取得|株式を取得|事業譲渡|事業承継|経営統合|合併|資本業務提携|資本提携|公開買付|TOB|グループ入り/ },
  { k: 'new', re: /新規事業|新事業|事業を開始|事業開始|参入|新会社|会社を設立|設立のお知らせ|立ち上げ|新ブランド|新サービス|提供開始|ローンチ/ },
  { k: 'mkt', re: /マーケティング|広告|販促|プロモーション|ブランディング|SNS|インフルエンサー|集客|CRM|リード獲得|D2C|PR戦略|調査レポート|意識調査|実態調査/ },
];
const GAME_RE = /新作ゲーム|ゲームアプリ|事前登録|Steam|Nintendo Switch|ニンテンドースイッチ|Switch 2|PS5|PlayStation|プレイステーション|ガチャ|RPG|ゲーム.{0,8}(配信|リリース|発売)|(配信|リリース|発売).{0,8}ゲーム/;

export function ruleJudge(a: JudgeInput): AiJudgement {
  const text = a.title + ' ' + a.lead.slice(0, 160);
  const tags = RULES.filter((r) => r.re.test(text)).map((r) => r.k);
  const strongTag = tags.find((t) => t === 'fund' || t === 'ipo' || t === 'ma');
  const softTag = tags.find((t) => t === 'new' || t === 'mkt');
  const isGame = (GAME_RE.test(a.title) || a.keywords.some((k) => /ゲーム/.test(k))) && !strongTag;
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
  return { score, reason, tags, ...(isGame ? { autoExclude: '新作ゲーム' } : {}), by: 'rule-v0' };
}

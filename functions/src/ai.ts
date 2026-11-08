import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { AiJudgement, Article } from './types';

/** 全記事のおすすめ度判定（件数が多いので安価なモデル） */
export const JUDGE_MODEL = 'claude-haiku-5-5';
/** おすすめ度「高」の記事の要約（件数が少ないので最高精度のモデル） */
export const SUMMARY_MODEL = 'claude-opus-5-5';

/** 保存する判定理由・要約・要点の長さの上限 */
const REASON_MAX = 60;
const SUMMARY_MAX = 400;
const POINTS_MAX = 8;

const TAG_KEYS = ['fund', 'ipo', 'ma', 'new', 'mkt'] as const;

const JudgeOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      score: z.enum(['high', 'mid', 'low']),
      tags: z.array(z.enum(TAG_KEYS)),
      reason: z.string(),
      exclude: z.string(),
    }),
  ),
});

const SummaryOutput = z.object({
  summary: z.string(),
  points: z.array(z.object({ label: z.string(), value: z.string() })),
});

/** 判定の基準（変わらない部分。プロンプトキャッシュが効くように先頭に置く） */
export const JUDGE_SYSTEM = `あなたは、ある事業会社の担当者のために PR TIMES のプレスリリースを仕分けるアシスタントです。
担当者は毎日大量のリリースから、事業の参考になる情報だけを読みたいと考えています。

# 特に知りたいテーマ（tags）
- fund: 資金調達（第三者割当増資、シリーズ○ラウンド、デットファイナンス、ファンド組成など）
- ipo: 上場（新規上場、上場承認、市場変更）
- ma: M&A（買収、子会社化、合併、事業譲渡、資本業務提携、TOB）
- new: 新規事業（新会社設立、新規事業の開始、新市場への参入、事業の立ち上げ）
- mkt: マーケティング（マーケティング施策や手法、広告・販促の新しい取り組み、消費者調査、ブランディング）
該当するものをすべて tags に入れてください。単なる新商品の発売や、イベント・セミナーの告知は new や mkt に含めません。

# おすすめ度（score）
- high: fund・ipo・ma に該当する、または新規事業・マーケティングで事業の参考になる具体的な内容がある
- mid: 業務提携、上場企業の経営に関する発表、注目テーマに関係しそうだが情報が薄いもの
- low: 上記以外（一般的な商品・サービスの告知、キャンペーン、イベント、人事、受賞、採用など）
企業規模や業界で優先度は変えません。

# 自動除外（exclude）
次に当てはまる場合は exclude にその名前を入れ、score は low にします。当てはまらなければ空文字にします。
- 新作ゲーム: ゲームの新作・配信開始・事前登録・アップデート・コラボイベントの案内
ただし、ゲーム会社の資金調達・上場・M&A は除外しません。
定時株主総会の開催や招集通知は low にします。

# 出力
入力された記事すべてについて、id をそのまま返してください。reason は日本語で20字以内にします。`;

export interface Example {
  title: string;
  company: string;
  label: 'read' | 'drop';
  /** そのときのAI判定（見落とし・過大評価の手がかり） */
  aiScore?: string;
}

/** 担当者の振り分け履歴を、判定の手本として渡す */
export function examplesText(ex: Example[]): string {
  if (!ex.length) return '';
  const line = (e: Example) => {
    const note =
      e.label === 'read' && e.aiScore && e.aiScore !== 'high'
        ? '（AIは見落としていた）'
        : e.label === 'drop' && e.aiScore === 'high'
          ? '（AIは高にしていたが不要だった）'
          : '';
    return `- ${e.title}（${e.company}）${note}`;
  };
  const read = ex.filter((e) => e.label === 'read');
  const drop = ex.filter((e) => e.label === 'drop');
  return [
    '# 担当者の実際の判断（これに近い記事は同じように扱ってください）',
    read.length ? `## 読んだ記事 → high が妥当\n${read.map(line).join('\n')}` : '',
    drop.length ? `## 不要にした記事 → low が妥当\n${drop.map(line).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
}

const usageOf = (model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }): Usage => ({
  model,
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

/**
 * 記事をまとめて判定する。拒否・失敗したものは結果に含めない（呼び出し側でルール判定のまま残す）。
 * refused: 拒否された、または出力が読み取れなかった（呼び出し側で件数を分けてやり直す）
 */
export async function judgeArticles(
  client: Anthropic,
  articles: Article[],
  examples: Example[],
): Promise<{ results: Map<string, AiJudgement>; usage: Usage; refused: boolean }> {
  const input = articles.map((a) => ({
    id: a.id,
    title: a.title,
    company: a.company,
    lead: a.lead.slice(0, 150),
    keywords: a.keywords.slice(0, 6),
    listed: Boolean(a.ticker),
    type: a.section,
  }));
  const ex = examplesText(examples);
  const response = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 8000,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: zodOutputFormat(JudgeOutput) },
    system: [
      { type: 'text', text: JUDGE_SYSTEM, cache_control: { type: 'ephemeral' } },
      ...(ex ? [{ type: 'text' as const, text: ex, cache_control: { type: 'ephemeral' as const } }] : []),
    ],
    messages: [{ role: 'user', content: `次の${input.length}件を判定してください。\n${input.map((x) => JSON.stringify(x)).join('\n')}` }],
  });
  const usage = usageOf(JUDGE_MODEL, response.usage);
  const results = new Map<string, AiJudgement>();
  if (response.stop_reason === 'refusal' || !response.parsed_output) return { results, usage, refused: true };
  const ids = new Set(articles.map((a) => a.id));
  for (const r of response.parsed_output.results) {
    if (!ids.has(r.id)) continue;
    const exclude = r.exclude.trim();
    results.set(r.id, {
      score: exclude ? 'low' : r.score,
      // 保存するドキュメントが大きくなりすぎないように長さを抑える（指示は20字以内）
      reason: r.reason.slice(0, REASON_MAX),
      tags: [...new Set(r.tags)],
      ...(exclude ? { autoExclude: exclude } : {}),
      by: JUDGE_MODEL,
    });
  }
  return { results, usage, refused: false };
}

export const SUMMARY_SYSTEM = `あなたは事業会社の担当者のためにプレスリリースを要約するアシスタントです。
担当者は資金調達・上場・M&A・新規事業・マーケティングの動向を把握したいと考えています。

summary: 何が起きたかを日本語3文以内（合計150字程度）でまとめます。宣伝文句は省き、事実を書きます。
points: 記事に書かれている要点だけを、label と value の組で挙げます。記事に書かれていない項目は入れません。
- 資金調達なら: 調達額、ラウンド、引受先、資金使途
- M&A なら: 買収する側、される側、金額、目的
- 上場なら: 市場、上場日、証券コード
- 新規事業・マーケティングなら: サービス名、対象顧客、ねらい
- それ以外でも、日付・金額・数値など判断に役立つ事実があれば挙げます`;

/** 記事本文を要約する（Claude Opus。拒否されたときは推奨モデルで自動的にやり直す） */
export async function summarizeArticle(
  client: Anthropic,
  a: Article,
  body: string,
): Promise<{ summary?: { summary: string; points: { label: string; value: string }[] }; usage: Usage }> {
  const response = await client.beta.messages.parse({
    model: SUMMARY_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(SummaryOutput) },
    system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `タイトル: ${a.title}\n会社: ${a.company}\n配信日時: ${a.publishedAt}\n\n本文:\n${body}`,
      },
    ],
  });
  const usage = usageOf(response.model ?? SUMMARY_MODEL, response.usage);
  if (response.stop_reason === 'refusal' || !response.parsed_output) return { usage };
  // 保存するドキュメントが大きくなりすぎないように長さを抑える（buckets.ts の余裕の前提）
  const o = response.parsed_output;
  return {
    summary: {
      summary: o.summary.slice(0, SUMMARY_MAX),
      points: o.points.slice(0, POINTS_MAX).map((p) => ({ label: p.label.slice(0, 30), value: p.value.slice(0, 120) })),
    },
    usage,
  };
}

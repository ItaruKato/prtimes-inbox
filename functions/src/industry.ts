import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { withLease } from './lease';
import { addUsage } from './notes';

/**
 * 業界タグ（営業向けの独自分類。台帳の処理。Long List・Knowledge Base で共通に使う）。
 * 作ったのは Long List のチャット（2026-11-12 本人が決定：メイン1つ＋サブ2つまで、BtoB／BtoC も付ける）。
 * - 依頼：industryQueue/{会社ID}（models: 使う AI、apply: 台帳に書く AI）。Long List の画面と、Long List の関数（まだタグのない会社を6時間ごとに）が書く
 * - 全社に付ける AI は Opus（2026-11-12 本人が決定）
 * - AI（Claude）が、PR TIMES の記事の見出し・PR TIMES の業種・gBizINFO の事業の概要・HP の会社名から決める
 * - 書く：industryTrials/{会社ID}.{AI} に結果（お試しで AI を比べるため）。apply なら companies/{会社ID}.industryTags にも
 * - 分類の表は meta/industryTags にも書く（画面はそこから名前を読む）
 */

export const INDUSTRY_V = 1;

export const INDUSTRY_TAGS: { code: string; label: string; group: string }[] = [
  { code: 'saas', label: 'SaaS・業務ソフト', group: 'IT・デジタル' },
  { code: 'ai', label: 'AI・データ活用', group: 'IT・デジタル' },
  { code: 'si', label: 'システム開発・SI', group: 'IT・デジタル' },
  { code: 'webapp', label: 'Web サービス・アプリ', group: 'IT・デジタル' },
  { code: 'game', label: 'ゲーム', group: 'IT・デジタル' },
  { code: 'security', label: 'セキュリティ', group: 'IT・デジタル' },
  { code: 'telecom', label: '通信・IT インフラ', group: 'IT・デジタル' },
  { code: 'fintech', label: 'フィンテック', group: 'IT・デジタル' },
  { code: 'marketing', label: '広告・マーケティング支援', group: 'マーケ・メディア' },
  { code: 'media', label: 'メディア・出版', group: 'マーケ・メディア' },
  { code: 'entertainment', label: 'エンタメ・音楽・映像', group: 'マーケ・メディア' },
  { code: 'event', label: 'イベント・PR', group: 'マーケ・メディア' },
  { code: 'staffing', label: '人材紹介・派遣', group: '人・組織' },
  { code: 'hr', label: 'HR テック・研修・組織開発', group: '人・組織' },
  { code: 'consulting', label: 'コンサルティング', group: '専門サービス' },
  { code: 'professional', label: '士業（法律・会計・税務）', group: '専門サービス' },
  { code: 'bpo', label: 'BPO・アウトソーシング', group: '専門サービス' },
  { code: 'finance', label: '銀行・証券・投資', group: '金融・不動産・建設' },
  { code: 'insurance', label: '保険', group: '金融・不動産・建設' },
  { code: 'realestate', label: '不動産・不動産テック', group: '金融・不動産・建設' },
  { code: 'construction', label: '建設・住宅・リフォーム', group: '金融・不動産・建設' },
  { code: 'food', label: '食品・飲料メーカー', group: 'ものづくり' },
  { code: 'cosmetics', label: '化粧品・日用品メーカー', group: 'ものづくり' },
  { code: 'apparel', label: 'アパレル・ファッション', group: 'ものづくり' },
  { code: 'machinery', label: '機械・電機・精密', group: 'ものづくり' },
  { code: 'chemical', label: '化学・素材', group: 'ものづくり' },
  { code: 'mobility', label: '自動車・モビリティ', group: 'ものづくり' },
  { code: 'energy', label: 'エネルギー・環境・脱炭素', group: 'ものづくり' },
  { code: 'retail', label: '小売・専門店', group: '小売・流通' },
  { code: 'ec', label: 'EC・D2C', group: '小売・流通' },
  { code: 'wholesale', label: '卸売・商社', group: '小売・流通' },
  { code: 'logistics', label: '物流・運輸', group: '小売・流通' },
  { code: 'restaurant', label: '外食・飲食', group: '生活サービス' },
  { code: 'travel', label: 'ホテル・旅行・観光', group: '生活サービス' },
  { code: 'beauty', label: '美容・サロン', group: '生活サービス' },
  { code: 'sports', label: 'スポーツ・フィットネス', group: '生活サービス' },
  { code: 'pet', label: 'ペット', group: '生活サービス' },
  { code: 'ceremony', label: '冠婚葬祭', group: '生活サービス' },
  { code: 'childcare', label: '子育て・ベビー', group: '生活サービス' },
  { code: 'clinic', label: '医療機関・クリニック', group: '医療・福祉・教育' },
  { code: 'pharma', label: '製薬・バイオ・医療機器', group: '医療・福祉・教育' },
  { code: 'healthcare', label: 'ヘルスケア・ウェルネス', group: '医療・福祉・教育' },
  { code: 'care', label: '介護・福祉', group: '医療・福祉・教育' },
  { code: 'education', label: '教育・スクール・EdTech', group: '医療・福祉・教育' },
  { code: 'agri', label: '農林水産・地方創生', group: 'その他' },
  { code: 'other', label: 'その他', group: 'その他' },
];
const CODES = INDUSTRY_TAGS.map((t) => t.code) as [string, ...string[]];

/** お試しで比べる AI（キーは画面と industryTrials の項目名に使う） */
export const INDUSTRY_MODELS = {
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  opus: 'claude-opus-5-5',
} as const;
export type ModelKey = keyof typeof INDUSTRY_MODELS;
const isModelKey = (k: unknown): k is ModelKey => typeof k === 'string' && k in INDUSTRY_MODELS;

export const IndustryOut = z.object({
  main: z.enum(CODES),
  subs: z.array(z.enum(CODES)),
  biz: z.enum(['btob', 'btoc', 'both']),
  confidence: z.enum(['high', 'mid', 'low']),
  reason: z.string(),
});
export type IndustryOutput = z.infer<typeof IndustryOut>;

export interface IndustryResult extends IndustryOutput {
  v: number;
  /** 実際に答えた AI */
  model: string;
  at: string;
}

export const INDUSTRY_SYSTEM = `あなたは営業リストのために、日本の会社の業界を分類する係です。
渡された材料（会社名、PR TIMES の業種、事業の概要、PR TIMES に出したプレスリリースの見出し）から、その会社が「主に何をして売上を上げているか」で次の分類から選びます。

${INDUSTRY_TAGS.map((t) => `- ${t.code}: ${t.label}（${t.group}）`).join('\n')}

決め方：
- main：会社の本業に一番近いもの1つ。1本のリリースの話題（キャンペーン・提携先・イベント）ではなく、見出し全体から本業を読む。
- subs：本業とは別に、はっきり大きな事業があるときだけ2つまで。なければ空にする。main と同じものは入れない。
- biz：主なお客様が会社なら btob、個人なら btoc、どちらも大きければ both。
- confidence：材料ではっきり決まれば high、だいたい決まれば mid、材料が少ない・迷うなら low。
- reason：決めた理由を日本語40字くらいで（例：「法人向け勤怠管理クラウドの機能追加のリリースが中心」）。
- どれにも当てはまらないときだけ other にする。`;

type Data = Record<string, unknown>;

/** AI に渡す材料（会社の台帳と、会社ごとの記事の一覧から） */
export function industryInput(c: Data, articles: Record<string, { t?: string; p?: string }> | undefined, maxTitles = 30): string {
  const profile = (c.profile ?? {}) as Data;
  const gbiz = (c.gbiz ?? {}) as Data;
  const web = (c.web ?? {}) as Record<string, { value?: string } | undefined>;
  const titles = Object.values(articles ?? {})
    .filter((a) => a?.t)
    .sort((a, b) => String(b.p ?? '').localeCompare(String(a.p ?? '')))
    .slice(0, maxTitles)
    .map((a) => `- ${String(a.p ?? '').slice(0, 10)} ${String(a.t).slice(0, 120)}`);
  const lines = [
    `会社名: ${String(c.name ?? '')}`,
    gbiz.name ? `正式な名前: ${String(gbiz.name)}` : '',
    web.officialName?.value ? `HP の会社名: ${web.officialName.value}` : '',
    profile.industry ? `PR TIMES の業種: ${String(profile.industry)}` : '',
    gbiz.summary ? `事業の概要（gBizINFO）: ${String(gbiz.summary).slice(0, 400)}` : '',
    Array.isArray(gbiz.businessItems) && gbiz.businessItems.length ? `事業項目（gBizINFO）: ${(gbiz.businessItems as unknown[]).map(String).join('、').slice(0, 300)}` : '',
    `プレスリリースの見出し（新しい順、${titles.length}件）:`,
    ...titles,
  ];
  return lines.filter(Boolean).join('\n');
}

/** AI の答えを整える（サブは2つまで、main と重ならない、理由は短く） */
export function tidyIndustry(o: IndustryOutput): IndustryOutput {
  const subs = [...new Set(o.subs)].filter((s) => s !== o.main).slice(0, 2);
  return { ...o, subs, reason: o.reason.trim().slice(0, 120) };
}

export async function classifyIndustry(client: Anthropic, db: Firestore, key: ModelKey, input: string): Promise<IndustryResult> {
  const model = INDUSTRY_MODELS[key];
  // お試しで AI を比べるので、断られたときに別の AI へ切り替える仕組み（fallbacks）は使わない
  const r = await client.beta.messages.parse({
    model,
    max_tokens: 4000,
    output_config: { effort: 'medium', format: betaZodOutputFormat(IndustryOut) },
    system: [{ type: 'text', text: INDUSTRY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: input }],
  });
  await addUsage(db, { model: r.model ?? model, input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens ?? 0 });
  const o = r.parsed_output;
  if (r.stop_reason === 'refusal' || !o) throw new Error(`業界を決められませんでした（${r.stop_reason}）`);
  return { ...tidyIndustry(o), v: INDUSTRY_V, model: r.model ?? model, at: new Date().toISOString() };
}

/** 1回（5分ごと）に処理する数。2026-11-13 本人の指示で速めた（80社・6並び → 160社・10並び。1時間に約1,900社） */
const PER_RUN = 160;
const PARALLEL = 10;
const MAX_TRIES = 3;
const ID_RE = /^\d+$/;

/** industryQueue の依頼を少しずつ処理する（5分ごと）。同じ AI で答えが出ている会社は読み直さない（redo なら読む） */
export async function industrySweep(deps: {
  db: Firestore;
  client: () => Anthropic;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'industry', 290_000, async () => {
    const until = Date.now() + (deps.budgetMs ?? 240_000);
    await db.collection('meta').doc('industryTags').set({ v: INDUSTRY_V, tags: INDUSTRY_TAGS, models: INDUSTRY_MODELS });
    const q = await db.collection('industryQueue').orderBy('at').limit(PER_RUN).get();
    const counts: Record<string, number> = {};
    const add = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
    let next = 0;
    const worker = async () => {
      while (next < q.docs.length && Date.now() < until) {
        const d = q.docs[next++];
        const models = ((d.get('models') as unknown[]) ?? []).filter(isModelKey);
        try {
          if (!ID_RE.test(d.id) || !models.length) throw new Error('依頼の形が正しくありません');
          const [cs, as, ts] = await db.getAll(db.collection('companies').doc(d.id), db.collection('companyArticles').doc(d.id), db.collection('industryTrials').doc(d.id));
          if (!cs.exists) {
            await d.ref.delete();
            add('notfound');
            continue;
          }
          const input = industryInput(cs.data()!, as.get('a'));
          const results: Partial<Record<ModelKey, IndustryResult>> = {};
          for (const m of models) {
            if (!d.get('redo') && ts.get(m)?.main) results[m] = ts.get(m);
            else {
              results[m] = await classifyIndustry(deps.client(), db, m, input);
              add(m);
            }
          }
          const b = db.batch();
          b.set(db.collection('industryTrials').doc(d.id), { ...results, name: cs.get('name') ?? '' }, { merge: true });
          // 台帳に書くのは、決めた AI（apply に AI の名前）の答え
          const apply = d.get('apply');
          if (isModelKey(apply) && results[apply]) b.set(cs.ref, { industryTags: results[apply] }, { merge: true });
          b.delete(d.ref);
          await b.commit();
        } catch (e) {
          add('failed');
          const tries = Number(d.get('tries') ?? 0) + 1;
          deps.log?.('industry failed', { company: d.id, error: String(e).slice(0, 200) });
          if (tries >= MAX_TRIES) {
            await db.collection('industryTrials').doc(d.id).set({ error: String(e).slice(0, 200), errorAt: new Date().toISOString() }, { merge: true });
            await d.ref.delete();
          } else await d.ref.set({ tries, lastError: String(e).slice(0, 200), at: FieldValue.serverTimestamp() }, { merge: true });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    const left = (await db.collection('industryQueue').count().get()).data().count;
    const result = { ...counts, left };
    await db.collection('meta').doc('industry').set({ ...result, lastRunAt: new Date().toISOString() });
    return result;
  });
  if (!r.ran) return { skipped: true };
  if (Object.keys(r.value).some((k) => k !== 'left') || r.value.left) deps.log?.('industry sweep', r.value);
  return r.value;
}

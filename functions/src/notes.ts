import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { extractBody } from './parse';
import { httpGet } from './collect';
import { jstKey } from './enrich';
import type { Usage } from './ai';

/**
 * 「読む」にした記事の、営業向けの要点とメモの下書き（drafts/{記事ID}）と、音声メモの清書。
 * 下書きは Cloud Functions だけが書く。利用者のメモ（notes/{記事ID}）は画面が書く。
 */

export const DRAFT_MODEL = 'claude-opus-5-5';

/** 利用者が提供しているサービス（営業でどれが刺さりそうかを AI に考えてもらう） */
export const SERVICES = ['経営・事業支援', '資金調達・M&A支援', 'マーケ・営業支援', '人材・組織支援'] as const;

const DraftOutput = z.object({
  summary: z.string(),
  points: z.array(z.object({ label: z.string(), value: z.string() })),
  angles: z.array(z.string()),
  fits: z.array(z.object({ service: z.enum(SERVICES), reason: z.string() })),
  memo: z.string(),
  industry: z.string(),
});

export interface Draft {
  v: 1;
  state: 'working' | 'done' | 'failed';
  at: string;
  model?: string;
  summary?: string;
  points?: { label: string; value: string }[];
  /** 営業トークで使える切り口 */
  angles?: string[];
  /** 相性がよさそうな自社サービスと理由 */
  fits?: { service: string; reason: string }[];
  /** 利用者のメモの下書き */
  memo?: string;
  /** 営業向けの業界（仮。分類はあとで整える） */
  industry?: string;
  error?: string;
}

export const DRAFT_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のアシスタントです。
担当者は PR TIMES のプレスリリースを読み、営業トークの材料、先行事例、会社の情報として蓄えています。
渡された記事について、次の項目を日本語で作ってください。記事に書かれていないことは推測で書かず、推測を含むときは「〜の可能性」と書きます。

summary: 何が起きたかを3文以内（合計150字程度）。宣伝文句は省き、事実を書く。
points: 判断に役立つ事実を label と value の組で（例: 調達額 / 10億円、ラウンド / シリーズA、引受先、提携先、対象顧客、開始日）。最大8個。
angles: 営業トークで使える切り口を2〜4個。この会社に話しかけるきっかけ、または他社に事例として紹介するときの話し方を、1文ずつ。
fits: 担当者のサービス（経営・事業支援、資金調達・M&A支援、マーケ・営業支援、人材・組織支援）のうち、この会社に必要になりそうなものと理由（1文）。当てはまらなければ空の配列。
memo: 担当者が後で読み返すためのメモの下書き。「なぜ大事か」「次に何をするか」を含めて、2〜4行の箇条書き（各行は「・」で始める）。
industry: この会社の業界を、営業で使う短い言葉で1つ（例: SaaS、物流、不動産テック、D2C、医療・ヘルスケア、製造、人材、飲食、自治体）。`;

const usageOf = (model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }): Usage => ({
  model,
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

/** 利用量を aiUsage/{日} に足す（画面の費用表示と同じ集計） */
export async function addUsage(db: Firestore, u: Usage): Promise<void> {
  const day = jstKey(Date.now(), 8);
  await db
    .collection('aiUsage')
    .doc(day)
    .set(
      {
        [u.model]: {
          input: FieldValue.increment(u.input),
          output: FieldValue.increment(u.output),
          cacheRead: FieldValue.increment(u.cacheRead),
          requests: FieldValue.increment(1),
        },
      },
      { merge: true },
    );
}

interface SavedArticle {
  id: string;
  url: string;
  title: string;
  company: string;
  publishedAt: string;
  lead?: string;
}

/** 下書きを作り始めてよいか（作業中の印を付ける）。作り終えた・作業中なら false */
async function claim(db: Firestore, id: string): Promise<boolean> {
  const ref = db.collection('drafts').doc(id);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.data() as Draft | undefined;
    if (d?.state === 'done') return false;
    // 作業中の印が10分より新しければ、ほかの回が作っている
    if (d?.state === 'working' && Date.now() - new Date(d.at).getTime() < 10 * 60e3) return false;
    // 失敗が3回続いた記事は、自動ではもう作らない（画面の「作り直す」で消せばやり直す）
    if (d?.state === 'failed' && ((s.get('tries') as number | undefined) ?? 0) >= 3) return false;
    tx.set(ref, { v: 1, state: 'working', at: new Date().toISOString() }, { merge: true });
    return true;
  });
}

/** 1件の下書きを作る。作らなかったときは false */
export async function makeDraft(
  db: Firestore,
  client: Anthropic,
  id: string,
  deps: { get?: (url: string) => Promise<string>; log?: (msg: string, data?: Record<string, unknown>) => void } = {},
): Promise<boolean> {
  const saved = await db.collection('saved').doc(id).get();
  const a = saved.get('article') as SavedArticle | undefined;
  if (!a) return false;
  if (!(await claim(db, id))) return false;
  const ref = db.collection('drafts').doc(id);
  try {
    let body = '';
    try {
      body = extractBody(await (deps.get ?? httpGet)(a.url));
    } catch (e) {
      deps.log?.('draft: article fetch failed', { id, error: String(e) });
    }
    const response = await client.beta.messages.parse({
      model: DRAFT_MODEL,
      max_tokens: 6000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(DraftOutput) },
      system: [{ type: 'text', text: DRAFT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `タイトル: ${a.title}\n会社: ${a.company}\n配信日時: ${a.publishedAt}\n\n本文:\n${body || a.lead || '（本文を取得できませんでした。タイトルから分かる範囲で）'}`,
        },
      ],
    });
    await addUsage(db, usageOf(response.model ?? DRAFT_MODEL, response.usage));
    const o = response.parsed_output;
    if (response.stop_reason === 'refusal' || !o) throw new Error(`下書きを作れませんでした（${response.stop_reason}）`);
    const draft: Draft = {
      v: 1,
      state: 'done',
      at: new Date().toISOString(),
      model: response.model ?? DRAFT_MODEL,
      summary: o.summary.slice(0, 400),
      points: o.points.slice(0, 8).map((p) => ({ label: p.label.slice(0, 30), value: p.value.slice(0, 120) })),
      angles: o.angles.slice(0, 4).map((s) => s.slice(0, 160)),
      fits: o.fits.slice(0, 4).map((f) => ({ service: f.service, reason: f.reason.slice(0, 160) })),
      memo: o.memo.slice(0, 600),
      industry: o.industry.slice(0, 30),
    };
    await ref.set({ ...draft, tries: FieldValue.delete(), error: FieldValue.delete() }, { merge: true });
    await syncHandoff(db, id);
    return true;
  } catch (e) {
    await ref.set({ state: 'failed', at: new Date().toISOString(), error: String(e).slice(0, 300), tries: FieldValue.increment(1) }, { merge: true });
    deps.log?.('draft failed', { id, error: String(e) });
    return false;
  }
}

/** 下書きのない「読む」「読了」の記事を探して作る（画面からの依頼が届かなかったときの予備） */
export async function draftSweep(
  db: Firestore,
  client: Anthropic,
  deps: { limit?: number; log?: (msg: string, data?: Record<string, unknown>) => void } = {},
) {
  const recent = await db.collection('saved').orderBy('decision.at', 'desc').limit(200).get();
  const ids = recent.docs.map((d) => d.id);
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await db.getAll(...ids.slice(i, i + 100).map((x) => db.collection('drafts').doc(x)));
    for (const s of snaps) if (s.exists && s.get('state') !== 'working') have.add(s.id);
  }
  let made = 0;
  for (const id of ids.filter((x) => !have.has(x)).slice(0, deps.limit ?? 15)) if (await makeDraft(db, client, id, deps)) made++;
  deps.log?.('draft sweep', { checked: ids.length, made });
  return { checked: ids.length, made };
}

/**
 * Knowledge Base への受け渡し（handoff/{記事ID}）。読了（done）にした記事の、記事・AIの下書き・利用者のメモをまとめる。
 * 画面も読了やメモの保存のたびに書く。ここでは下書きができたときに書き直す。
 */
export async function syncHandoff(db: Firestore, id: string): Promise<void> {
  const [saved, note, draft] = await db.getAll(
    db.collection('saved').doc(id),
    db.collection('notes').doc(id),
    db.collection('drafts').doc(id),
  );
  const ref = db.collection('handoff').doc(id);
  if (!saved.exists || saved.get('decision.status') !== 'done') return;
  const d = draft.data() as (Draft & { tries?: number }) | undefined;
  let done: Omit<Draft, 'state'> | null = null;
  if (d?.state === 'done') {
    const { state: _s, tries: _t, error: _e, ...rest } = d; // eslint-disable-line @typescript-eslint/no-unused-vars
    done = rest;
  }
  await ref.set(
    {
      v: 1,
      id,
      article: saved.get('article'),
      readAt: saved.get('decision.at') ?? null,
      memo: note.get('memo') ?? '',
      myTags: note.get('myTags') ?? [],
      stars: note.get('stars') ?? 0,
      draft: done,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

// ---- 音声メモ ----

export const TIDY_SYSTEM = `あなたは営業担当者のメモ係です。担当者がプレスリリースを読みながら話した内容の書き起こしを、メモとして読みやすく整えます。
- 「えー」「あの」などの言いよどみ、言い直し、重複を取り除く
- 話した内容だけを書く。言っていないことは足さない
- 1〜5行の箇条書き（各行は「・」で始める）にする
- 書き起こしの誤変換と思われる語は、記事のタイトル・会社名を手がかりに直してよい`;

/** 書き起こしをメモとして整える */
export async function tidyTranscript(
  client: Anthropic,
  db: Firestore,
  transcript: string,
  ctx: { title?: string; company?: string },
): Promise<string> {
  const response = await client.beta.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: TIDY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `記事: ${ctx.title ?? ''}（${ctx.company ?? ''}）\n\n書き起こし:\n${transcript}\n\n整えたメモだけを出力してください。`,
      },
    ],
  });
  await addUsage(db, usageOf(response.model ?? DRAFT_MODEL, response.usage));
  if (response.stop_reason === 'refusal') return transcript;
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || transcript;
}

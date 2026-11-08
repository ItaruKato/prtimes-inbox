import Anthropic from '@anthropic-ai/sdk';
import { FieldPath, FieldValue, type Firestore, type WriteBatch } from 'firebase-admin/firestore';
import { judgeArticles, summarizeArticle, type Example, type Usage } from './ai';
import { extractBody } from './parse';
import { commitOps, httpGet } from './collect';
import { ruleJudge } from './judge';
import { withLease } from './lease';
import { BUCKET_MAX_BYTES, BUCKET_MAX_INDEX, BucketPlanner, hourOf, itemCost, valueSize } from './buckets';
import type { AiJudgement, Article } from './types';

/** 1回の実行で判定する上限（費用の上限にもなる） */
export const JUDGE_LIMIT = 3000;
/** 1回のリクエストで判定する件数 */
export const JUDGE_CHUNK = 40;
/** 判定のリクエストを同時に送る数（API の利用上限に当たりにくいように少なめ） */
export const JUDGE_CONCURRENCY = 2;
/** 1回の実行で要約する上限 */
export const SUMMARY_LIMIT = 60;
/** 要約のリクエストを同時に送る数 */
export const SUMMARY_CONCURRENCY = 2;
/** 判定の新しいリクエストを送ってよい時間・全体で新しいリクエストを送ってよい時間（関数の制限時間 1200 秒に収める） */
const JUDGE_BUDGET_MS = 6 * 60e3;
const RUN_BUDGET_MS = 10 * 60e3;
/** 同時に2つ動かないようにする期間（関数の制限時間と同じ） */
const LEASE_MS = 20 * 60e3;
/** 判定の出力が読めなかったときに、件数を半分にしてやり直す深さ（40→20→…→1） */
const MAX_SPLIT_DEPTH = 6;
/** 判定のやり直し対象にする期間（時間）。さかのぼって取り込んだ記事も含める */
const BACKLOG_HOURS = 24 * 10;
/** 判定の手本にする振り分け履歴の件数（読んだ・不要それぞれ） */
const EXAMPLES_PER_LABEL = 30;

const p2 = (n: number) => String(n).padStart(2, '0');
export function jstKey(ts: number, len: 8 | 10): string {
  const d = new Date(ts + 9 * 3600e3);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`.slice(0, len);
}

interface Decision {
  status: string;
  how: 'manual' | 'bulk';
  at: number;
  title?: string;
  company?: string;
  aiScore?: string;
}

/** 担当者の振り分け（手動のみ）から、判定の手本を作る */
export async function loadExamples(db: Firestore, now: Date): Promise<Example[]> {
  const since = jstKey(now.getTime() - 30 * 86400e3, 8);
  const snap = await db.collection('decisions').where(FieldPath.documentId(), '>=', since).get();
  const all: Decision[] = [];
  for (const d of snap.docs) for (const x of Object.values((d.data().d ?? {}) as Record<string, Decision>)) all.push(x);
  const usable = all.filter((d) => d.how === 'manual' && d.title).sort((a, b) => b.at - a.at);
  const pick = (label: Example['label'], ok: (s: string) => boolean) =>
    usable
      .filter((d) => ok(d.status))
      .slice(0, EXAMPLES_PER_LABEL)
      .map((d) => ({ title: d.title!, company: d.company ?? '', label, aiScore: d.aiScore }));
  return [...pick('read', (s) => s === 'keep' || s === 'done'), ...pick('drop', (s) => s === 'drop')];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface EnrichDeps {
  db: Firestore;
  client: Anthropic;
  get?: (url: string) => Promise<string>;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** テスト用：判定・全体の時間の上限（ミリ秒） */
  judgeBudgetMs?: number;
  runBudgetMs?: number;
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};
/**
 * この回はもう新しいリクエストを送らないエラー。
 * 429（利用上限）・529（混雑）は SDK が待ってやり直した上での失敗なので、続けて送ると悪化するだけ。
 * 401・402・403（キー・残高・権限）は何度送っても失敗する。
 */
const isRateLimit = (e: unknown) => statusOf(e) === 429 || statusOf(e) === 529;
const isFatal = (e: unknown) => [401, 402, 403].includes(statusOf(e) ?? 0);
/** 応答がない・つながらない（SDK がやり直した上での失敗）。API の障害とみなして、この回は送らない */
const isConnection = (e: unknown) => e instanceof Anthropic.APIConnectionError;
/** API から返ったエラー（または通信エラー）。出力の読み取りの失敗とは分けて扱う */
const isApiError = (e: unknown) => e instanceof Anthropic.APIError || statusOf(e) !== undefined;

/**
 * 直近の記事を Claude で判定し、おすすめ度「高」の記事を要約する。
 * 失敗した記事はルール判定のまま残り、次の回にやり直す。
 * 同時に2つ動かない（locks/enrich）。
 */
export async function enrich(deps: EnrichDeps) {
  const log = deps.log ?? (() => {});
  const r = await withLease(deps.db, 'enrich', LEASE_MS, () => run(deps));
  if (!r.ran) {
    log('enrich skipped: previous run still in progress', { until: new Date(r.until).toISOString() });
    return { skipped: true as const };
  }
  return r.value;
}

async function run(deps: EnrichDeps) {
  const { db, client } = deps;
  const get = deps.get ?? httpGet;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const startedAt = Date.now();
  const judgeUntil = startedAt + (deps.judgeBudgetMs ?? JUDGE_BUDGET_MS);
  const runUntil = startedAt + (deps.runBudgetMs ?? RUN_BUDGET_MS);

  const since = jstKey(now().getTime() - BACKLOG_HOURS * 3600e3, 10);
  const snap = await db.collection('buckets').where(FieldPath.documentId(), '>=', since).get();
  // 続きのドキュメント（YYYYMMDDHH_2 など）も含めて、記事ごとの保存先と各ドキュメントの大きさを持つ
  const planner = new BucketPlanner(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
  const articles = planner.articles().filter((a) => a && a.id && a.publishedAt);
  articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const usages: Usage[] = [];
  const updates = new Map<string, AiJudgement>();
  let stopped: string | null = null;
  const stopFor = (e: unknown) => (isFatal(e) ? 'fatal' : isRateLimit(e) ? 'rateLimit' : isConnection(e) ? 'connection' : null);

  // 1) 判定（新しい記事から）
  const needJudge = articles.filter((a) => !a.ai?.by || (a.ai.by.startsWith('rule') && !a.ai.skipped));
  const toJudge = needJudge.slice(0, JUDGE_LIMIT);
  let judged = 0;
  let judgeErrors = 0;
  let refusedArticles = 0;
  const judgeStopped = () => stopped !== null || Date.now() >= judgeUntil;
  const judgeChunk = async (chunk: Article[], examples: Example[], depth: number): Promise<void> => {
    if (judgeStopped()) return;
    const halves = async () => {
      const mid = Math.ceil(chunk.length / 2);
      await judgeChunk(chunk.slice(0, mid), examples, depth + 1);
      await judgeChunk(chunk.slice(mid), examples, depth + 1);
    };
    let r: Awaited<ReturnType<typeof judgeArticles>>;
    try {
      r = await judgeArticles(client, chunk, examples);
    } catch (e) {
      // API のエラーはそのまま（分けても直らない）。出力の読み取りの失敗（途中で切れたなど）は分けてやり直す
      if (isApiError(e) || chunk.length === 1 || depth >= 2) throw e;
      log('judge output unreadable, splitting', { size: chunk.length, error: String(e) });
      return halves();
    }
    usages.push(r.usage);
    for (const [id, j] of r.results) {
      updates.set(id, j);
      judged++;
    }
    if (!r.refused) return;
    if (chunk.length > 1 && depth < MAX_SPLIT_DEPTH) {
      // 1件が断られるとまとめて送った全件が判定されないので、分けて送り直す
      log('judge refused, splitting', { size: chunk.length });
      return halves();
    }
    if (chunk.length === 1) {
      // 1件でも断られた記事はルール判定のまま残し、次の回からは送らない
      const a = chunk[0];
      updates.set(a.id, { ...(a.ai ?? ruleJudge(a)), skipped: 'refusal' });
      refusedArticles++;
      log('judge refused article', { id: a.id });
    }
  };
  if (toJudge.length) {
    const examples = await loadExamples(db, now());
    const chunks: Article[][] = [];
    for (let i = 0; i < toJudge.length; i += JUDGE_CHUNK) chunks.push(toJudge.slice(i, i + JUDGE_CHUNK));
    await mapLimit(chunks, JUDGE_CONCURRENCY, async (chunk) => {
      if (judgeStopped()) return;
      try {
        await judgeChunk(chunk, examples, 0);
      } catch (e) {
        judgeErrors++;
        stopped ??= stopFor(e);
        log('judge failed', { error: String(e), status: statusOf(e) });
      }
    });
  }
  // 判定がどこで止まったか（利用上限・時間切れ）。判定で利用上限に当たっても、要約（別のモデル）は試す
  const judgeStop = stopped ?? (Date.now() >= judgeUntil && judged + refusedArticles < toJudge.length ? 'time' : null);
  if (stopped === 'rateLimit') stopped = null;

  // 2) 要約（判定が「高」で、まだ要約がないもの）
  const current = (a: Article) => updates.get(a.id) ?? a.ai;
  const toSummarize = articles
    .filter((a) => {
      const j = current(a);
      return j?.by && !j.by.startsWith('rule') && j.score === 'high' && !j.autoExclude && !j.summary;
    })
    .slice(0, SUMMARY_LIMIT);
  let summarized = 0;
  let summaryErrors = 0;
  await mapLimit(toSummarize, SUMMARY_CONCURRENCY, async (a) => {
    if (stopped !== null || Date.now() >= runUntil) return;
    let body = '';
    try {
      body = extractBody(await get(a.url));
    } catch (e) {
      // 記事ページが消えている（4xx）ときは冒頭文で要約する。それ以外（一時的な失敗）は次の回にやり直す
      if (!/HTTP 4\d\d/.test(String(e))) {
        summaryErrors++;
        log('article page fetch failed', { id: a.id, error: String(e) });
        return;
      }
    }
    try {
      const { summary, usage } = await summarizeArticle(client, a, body || a.lead);
      usages.push(usage);
      if (summary) {
        updates.set(a.id, { ...current(a)!, summary: summary.summary, points: summary.points });
        summarized++;
      }
    } catch (e) {
      summaryErrors++;
      stopped ??= stopFor(e);
      log('summary failed', { id: a.id, error: String(e), status: statusOf(e) });
    }
  });

  // 3) 書き込み（記事ごとに ai を置き換える。ドキュメントごとにまとめる）
  const at = now();
  const byDoc = new Map<string, Map<string, AiJudgement>>();
  for (const [id, ai] of updates) {
    const docId = planner.where(id);
    const prev = planner.get(id);
    if (!docId || !prev) continue;
    planner.replace(docId, id, { ...prev, ai });
    const m = byDoc.get(docId) ?? new Map<string, AiJudgement>();
    m.set(id, ai);
    byDoc.set(docId, m);
  }
  // 要約を足すと 1 MiB に近づくドキュメントは、要約を付けた記事を同じ時間の続きのドキュメントへ移す
  // （画面は全ドキュメントを記事IDでまとめて読むので、どのドキュメントにあっても同じように見える）
  const moves = new Map<string, Map<string, Record<string, Article>>>(); // 移動元 → 移動先 → 記事
  let moved = 0;
  const over = (docId: string) => {
    const s = planner.size(docId)!;
    return s.bytes > BUCKET_MAX_BYTES || s.index > BUCKET_MAX_INDEX;
  };
  for (const [docId, m] of byDoc) {
    if (!over(docId)) continue;
    const candidates = [...m.entries()]
      .filter(([, ai]) => ai.summary)
      .map(([id]) => ({ id, cost: itemCost(id, planner.get(id)).bytes }))
      .sort((a, b) => b.cost - a.cost);
    for (const { id } of candidates) {
      if (!over(docId)) break;
      const article = planner.get(id)!;
      planner.remove(docId, id);
      const to = planner.place(hourOf(docId), id, article);
      m.delete(id);
      const dest = moves.get(docId) ?? new Map<string, Record<string, Article>>();
      dest.set(to, { ...(dest.get(to) ?? {}), [id]: article });
      moves.set(docId, dest);
      moved++;
    }
    if (over(docId)) log('bucket still too large after moving', { docId, ...planner.size(docId)! });
  }
  if (moved) log('moved summarized articles to overflow buckets', { moved });

  type Op = { bytes: number; apply: (b: WriteBatch) => void };
  const units: Op[][] = [];
  for (const docId of new Set([...byDoc.keys(), ...moves.keys()])) {
    const ref = db.collection('buckets').doc(docId);
    const pairs: [FieldPath, unknown][] = [...(byDoc.get(docId) ?? new Map())].map(
      ([id, ai]) => [new FieldPath('items', id, 'ai'), ai] as [FieldPath, unknown],
    );
    for (const id of [...(moves.get(docId)?.values() ?? [])].flatMap((x) => Object.keys(x)))
      pairs.push([new FieldPath('items', id), FieldValue.delete()]);
    // 移動（移動元から消す・移動先に書く）は同じバッチに入れる
    const unit: Op[] = [];
    for (let i = 0; i < pairs.length; i += 200) {
      const part = pairs.slice(i, i + 200);
      const flat = part.flat() as [FieldPath, unknown, ...unknown[]];
      unit.push({
        bytes: part.reduce((n, [, v]) => n + valueSize(v) + 100, 0),
        apply: (b) => b.update(ref, ...flat),
      });
    }
    for (const [to, items] of moves.get(docId) ?? [])
      unit.push({
        bytes: valueSize(items) + 200,
        apply: (b) => b.set(db.collection('buckets').doc(to), { items, updatedAt: at.toISOString() }, { merge: true }),
      });
    if (unit.length) units.push(unit);
  }
  await commitOps(db, units);

  // 4) 利用量の記録（画面に表示して費用を見えるようにする）
  const day = jstKey(at.getTime(), 8);
  const totals: Record<string, { input: number; output: number; cacheRead: number; requests: number }> = {};
  for (const u of usages) {
    const t = (totals[u.model] ??= { input: 0, output: 0, cacheRead: 0, requests: 0 });
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.requests++;
  }
  // モデルごとに加算（set + merge では入れ子のオブジェクトで書く）
  const inc: Record<string, Record<string, FieldValue>> = {};
  for (const [m, t] of Object.entries(totals))
    inc[m] = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, FieldValue.increment(v)]));
  const result = {
    judged,
    judgeErrors,
    summarized,
    summaryErrors,
    // 判定待ちの全件（1回の上限で切る前の件数）
    backlog: Math.max(0, needJudge.length - judged - refusedArticles),
    refused: refusedArticles,
    moved,
    // 途中でやめた理由（rateLimit: 利用上限・混雑 / connection: 応答なし / fatal: キー・残高 / time: 時間切れ）。残りは次の回に
    judgeStoppedBy: judgeStop,
    summaryStoppedBy: stopped,
  };
  const batch = db.batch();
  if (usages.length) batch.set(db.collection('aiUsage').doc(day), inc, { merge: true });
  batch.set(db.collection('meta').doc('ai'), { lastRunAt: at.toISOString(), ...result }, { merge: true });
  await batch.commit();
  log('enrich done', result);
  return result;
}

import type Anthropic from '@anthropic-ai/sdk';
import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { judgeArticles, summarizeArticle, type Example, type Usage } from './ai';
import { extractBody } from './parse';
import { httpGet } from './collect';
import type { AiJudgement, Article } from './types';

/** 1回の実行で判定する上限（費用の上限にもなる） */
export const JUDGE_LIMIT = 3000;
/** 1回のリクエストで判定する件数 */
export const JUDGE_CHUNK = 40;
/** 1回の実行で要約する上限 */
export const SUMMARY_LIMIT = 60;
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
}

/**
 * 直近の記事を Claude で判定し、おすすめ度「高」の記事を要約する。
 * 失敗した記事はルール判定のまま残り、次の回にやり直す。
 */
export async function enrich(deps: EnrichDeps) {
  const { db, client } = deps;
  const get = deps.get ?? httpGet;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  const since = jstKey(now().getTime() - BACKLOG_HOURS * 3600e3, 10);
  const snap = await db.collection('buckets').where(FieldPath.documentId(), '>=', since).get();
  const where = new Map<string, string>(); // 記事ID → バケット
  const articles: Article[] = [];
  for (const d of snap.docs)
    for (const a of Object.values((d.data().items ?? {}) as Record<string, Article>)) {
      where.set(a.id, d.id);
      articles.push(a);
    }
  articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const usages: Usage[] = [];
  const updates = new Map<string, AiJudgement>();

  // 1) 判定
  const toJudge = articles.filter((a) => !a.ai || a.ai.by.startsWith('rule')).slice(0, JUDGE_LIMIT);
  let judged = 0;
  let judgeErrors = 0;
  if (toJudge.length) {
    const examples = await loadExamples(db, now());
    const chunks: Article[][] = [];
    for (let i = 0; i < toJudge.length; i += JUDGE_CHUNK) chunks.push(toJudge.slice(i, i + JUDGE_CHUNK));
    await mapLimit(chunks, 5, async (chunk) => {
      try {
        const { results, usage } = await judgeArticles(client, chunk, examples);
        usages.push(usage);
        for (const [id, j] of results) {
          updates.set(id, j);
          judged++;
        }
      } catch (e) {
        judgeErrors++;
        log('judge failed', { error: String(e) });
      }
    });
  }

  // 2) 要約（判定が「高」で、まだ要約がないもの）
  const current = (a: Article) => updates.get(a.id) ?? a.ai;
  const toSummarize = articles
    .filter((a) => {
      const j = current(a);
      return j && !j.by.startsWith('rule') && j.score === 'high' && !j.autoExclude && !j.summary;
    })
    .slice(0, SUMMARY_LIMIT);
  let summarized = 0;
  let summaryErrors = 0;
  await mapLimit(toSummarize, 6, async (a) => {
    try {
      const body = extractBody(await get(a.url));
      const { summary, usage } = await summarizeArticle(client, a, body || a.lead);
      usages.push(usage);
      if (summary) {
        updates.set(a.id, { ...current(a)!, summary: summary.summary, points: summary.points });
        summarized++;
      }
    } catch (e) {
      summaryErrors++;
      log('summary failed', { id: a.id, error: String(e) });
    }
  });

  // 3) 書き込み（記事ごとに ai を置き換える）
  const at = now();
  const entries = [...updates];
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [id, ai] of entries.slice(i, i + 400))
      batch.update(db.collection('buckets').doc(where.get(id)!), new FieldPath('items', id, 'ai'), ai);
    await batch.commit();
  }

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
  const result = { judged, judgeErrors, summarized, summaryErrors, backlog: toJudge.length - judged };
  const batch = db.batch();
  if (usages.length) batch.set(db.collection('aiUsage').doc(day), inc, { merge: true });
  batch.set(db.collection('meta').doc('ai'), { lastRunAt: at.toISOString(), ...result }, { merge: true });
  await batch.commit();
  log('enrich done', result);
  return result;
}

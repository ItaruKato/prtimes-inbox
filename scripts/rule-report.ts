// 除外ルールの週次集計（GitHub Actions の rule-report ワークフローから実行）
// 本番の全記事と振り分けを読み、ルールごとの除外件数・戻した件数・取りこぼし候補を週ごとに ruleReports/{週の月曜} へ保存する。
// ルールの判定は画面と同じ src/lib/exclusion.ts を使う。
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { EXCLUSION_RULES, matchRules } from '../src/lib/exclusion';
import type { Article, Decision } from '../src/types';

const require = createRequire(import.meta.url);
const F = new URL('../functions/node_modules/firebase-admin/lib/', import.meta.url).pathname;
const { initializeApp } = require(F + 'app');
const { getFirestore } = require(F + 'firestore');

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

const DAY = 86400e3;
const JST = 9 * 3600e3;
const ymd = (ms: number) => new Date(ms + JST).toISOString().slice(0, 10);
/** その日時を含む週の月曜 0:00（JST）のミリ秒 */
function weekStart(ms: number) {
  const d = new Date(ms + JST);
  const dow = (d.getUTCDay() + 6) % 7; // 月曜=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - JST;
}

export interface RuleWeek {
  label: string;
  updated: string;
  excluded: number;
  restored: number;
  restoredTitles: string[];
}

async function main() {
  const buckets = await db.collection('buckets').get();
  const articles: Article[] = [];
  for (const d of buckets.docs) for (const a of Object.values((d.data().items ?? {}) as Record<string, Article>)) articles.push(a);
  const decisions: Record<string, Decision> = {};
  for (const d of (await db.collection('decisions').get()).docs) Object.assign(decisions, d.data().d ?? {});
  const disabled = new Set<string>(((await db.doc('config/exclusion').get()).data()?.disabledRules ?? []) as string[]);

  const now = Date.now();
  const thisWeek = weekStart(now);
  // 前の週（確定）と今週（途中）を作る
  const weeks = [thisWeek - 7 * DAY, thisWeek];
  const lines: string[] = [];
  for (const ws of weeks) {
    const we = ws + 7 * DAY;
    const inWeek = articles.filter((a) => {
      const t = new Date(a.publishedAt).getTime();
      return t >= ws && t < we;
    });
    const rules: Record<string, RuleWeek> = {};
    for (const r of EXCLUSION_RULES) rules[r.id] = { label: r.label, updated: r.updated, excluded: 0, restored: 0, restoredTitles: [] };
    for (const a of inWeek) {
      const ids = matchRules(a);
      for (const id of ids) {
        const s = rules[id];
        s.excluded++;
        const d = decisions[a.id];
        if (d && d.how === 'manual' && d.status !== 'drop') {
          s.restored++;
          if (s.restoredTitles.length < 10) s.restoredTitles.push(a.title);
        }
      }
    }
    // 利用者が理由付きで不要にしたのに、どのルールにも当たらない記事（新しいルールの候補）
    const weekDecisions = Object.entries(decisions).filter(([, d]) => d.at >= ws && d.at < we);
    const manualDrops = weekDecisions.filter(([, d]) => d.how === 'manual' && d.status === 'drop');
    const withReason = manualDrops.filter(([, d]) => d.reason || d.reasonTags?.length);
    const byId = new Map(articles.map((a) => [a.id, a]));
    const uncovered = withReason
      .filter(([id]) => {
        const a = byId.get(id);
        return !a || matchRules(a).every((r) => disabled.has(r));
      })
      .map(([, d]) => ({ title: d.title ?? '', company: d.company ?? '', reasonTags: d.reasonTags ?? [], reason: d.reason ?? '' }));
    const reasonTagCounts: Record<string, number> = {};
    for (const u of uncovered) for (const t of u.reasonTags) reasonTagCounts[t] = (reasonTagCounts[t] ?? 0) + 1;

    const key = ymd(ws);
    const report = {
      weekStart: key,
      weekEnd: ymd(we - DAY),
      complete: we <= now,
      generatedAt: new Date(now).toISOString(),
      totalArticles: inWeek.length,
      disabledRules: [...disabled],
      rules,
      manualDrops: manualDrops.length,
      withReason: withReason.length,
      uncovered: uncovered.slice(0, 40),
      uncoveredCount: uncovered.length,
      reasonTagCounts,
    };
    await db.collection('ruleReports').doc(key).set(report);

    lines.push(`## ${key}〜${report.weekEnd}${report.complete ? '' : '（途中）'}  記事 ${inWeek.length}件`);
    for (const [id, s] of Object.entries(rules)) {
      const pct = inWeek.length ? ((s.excluded / inWeek.length) * 100).toFixed(1) : '0.0';
      lines.push(`- ${s.label}（${id}${disabled.has(id) ? '・オフ' : ''}）: 除外 ${s.excluded}件（${pct}%） / 戻した ${s.restored}件${s.restoredTitles.length ? '：' + s.restoredTitles.join(' / ') : ''}`);
    }
    lines.push(`- 手動で不要 ${manualDrops.length}件（理由あり ${withReason.length}件） / どのルールにも当たらない理由あり ${uncovered.length}件 ${JSON.stringify(reasonTagCounts)}`);
    for (const u of uncovered.slice(0, 15)) lines.push(`  - ${u.title}｜[${u.reasonTags.join(',')}] ${u.reason}`);
  }
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// 除外ルール案の試し判定（GitHub Actions の rule-check ワークフローから実行）
// 本番の全記事にルール案（タイトルの正規表現）を当て、何件除外されるか・読んだ記事を巻き込まないかを出す。
// 使い方: PATTERN='セール|福袋' EXCEPT='資金調達|買収' node scripts/rule-check.cjs
const path = require('path');
const F = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib');
const { initializeApp } = require(path.join(F, 'app'));
const { getFirestore } = require(path.join(F, 'firestore'));

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

(async () => {
  const pattern = process.env.PATTERN;
  if (!pattern) throw new Error('PATTERN（タイトルの正規表現）を指定してください');
  const include = new RegExp(pattern);
  const except = process.env.EXCEPT ? new RegExp(process.env.EXCEPT) : null;
  const hit = (title) => include.test(title) && !(except && except.test(title));

  const buckets = await db.collection('buckets').get();
  const articles = [];
  for (const d of buckets.docs) for (const a of Object.values(d.data().items ?? {})) articles.push(a);

  const decisions = {};
  for (const d of (await db.collection('decisions').get()).docs) Object.assign(decisions, d.data().d ?? {});
  const saved = (await db.collection('saved').get()).docs.map((d) => d.data());

  const matched = articles.filter((a) => hit(a.title));
  const read = saved.filter((s) => hit(s.article.title));
  const restored = Object.values(decisions).filter((x) => x.how === 'manual' && x.status !== 'drop' && x.title && hit(x.title));
  const droppedByUser = Object.values(decisions).filter((x) => x.how === 'manual' && x.status === 'drop' && x.title);
  const coveredDrops = droppedByUser.filter((x) => hit(x.title));

  const out = [
    `ルール案: /${pattern}/${except ? ` 例外: /${except.source}/` : ''}`,
    `全記事 ${articles.length}件のうち除外される記事: ${matched.length}件（${((matched.length / Math.max(1, articles.length)) * 100).toFixed(2)}%）`,
    `「読む」「既読」に入れた記事のうち当てはまる: ${read.length}件 ← 0件が望ましい`,
    `受信箱などに戻した記事のうち当てはまる: ${restored.length}件 ← 0件が望ましい`,
    `手動で不要にした記事 ${droppedByUser.length}件のうち当てはまる: ${coveredDrops.length}件`,
    '除外される記事の例（最大60件）:',
    ...matched.slice(0, 60).map((a) => `  - ${a.title}｜${a.company}`),
  ];
  console.log(out.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out.join('\n') + '\n```\n');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

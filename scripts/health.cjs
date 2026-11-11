// 本番の健康診断（GitHub Actions の health ワークフローから実行）
// Firestore の状態と、直近のエラーログ、公開ページの応答をまとめて表示する。
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib');
const { initializeApp } = require(path.join(F, 'app'));
const { getFirestore, FieldPath } = require(path.join(F, 'firestore'));

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

const jst = (ms, len) => {
  const d = new Date(ms + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`.slice(0, len);
};

(async () => {
  const out = [];
  const log = (s) => {
    out.push(s);
    console.log(s);
  };
  const now = Date.now();

  for (const id of ['collector', 'backfill', 'backfillStore', 'ai']) {
    const d = (await db.doc(`meta/${id}`).get()).data();
    log(`meta/${id}: ${JSON.stringify(d ?? null)}`);
  }

  const since = jst(now - 10 * 86400e3, 10);
  const snap = await db.collection('buckets').where(FieldPath.documentId(), '>=', since).get();
  let total = 0;
  let maxBytes = 0;
  let maxDoc = '';
  const byModel = {};
  const byScore = {};
  let summarized = 0;
  let highNoSummary = 0;
  let latest = '';
  const perDay = {};
  for (const d of snap.docs) {
    const bytes = Buffer.byteLength(JSON.stringify(d.data()));
    if (bytes > maxBytes) {
      maxBytes = bytes;
      maxDoc = d.id;
    }
    for (const a of Object.values(d.data().items ?? {})) {
      total++;
      perDay[d.id.slice(0, 8)] = (perDay[d.id.slice(0, 8)] ?? 0) + 1;
      const by = a.ai?.by ?? 'none';
      byModel[by] = (byModel[by] ?? 0) + 1;
      const sc = a.ai?.score ?? 'none';
      byScore[sc] = (byScore[sc] ?? 0) + 1;
      if (a.ai?.summary) summarized++;
      else if (a.ai?.score === 'high' && !a.ai?.autoExclude && !String(by).startsWith('rule')) highNoSummary++;
      if (a.publishedAt > latest) latest = a.publishedAt;
    }
  }
  // 画面の「不要」（新作ゲーム）判定と同じ条件で数える：Claude の過去の判定 or キーワード
  const { ruleJudge } = require(path.join(__dirname, '..', 'functions', 'lib', 'functions', 'src', 'judge.js'));
  let gameByAi = 0;
  let gameByRule = 0;
  let game = 0;
  const gameSamples = [];
  for (const d of snap.docs)
    for (const a of Object.values(d.data().items ?? {})) {
      const ai = String(a.ai?.by ?? '').startsWith('claude') && a.ai?.autoExclude === '新作ゲーム';
      const rule = ruleJudge({ title: a.title, lead: a.lead ?? '', keywords: a.keywords ?? [], ticker: a.ticker ?? '', section: a.section ?? '' }).autoExclude === '新作ゲーム';
      if (ai) gameByAi++;
      if (rule) gameByRule++;
      if (ai || rule) {
        game++;
        if (gameSamples.length < 25) gameSamples.push(`${ai ? 'AI' : '  '}${rule ? 'KW' : '  '} ${a.title.slice(0, 60)}｜${a.company}｜kw=${(a.keywords ?? []).slice(0, 4).join(',')}`);
      }
    }
  log(`新作ゲーム扱い（不要に入る）: ${game}件（Claude ${gameByAi} / キーワード ${gameByRule}）`);
  log(gameSamples.join('\n'));
  log(`buckets(10日): ${snap.size}件のドキュメント / 記事 ${total}件 / 最新の配信 ${latest}`);
  // 一覧用の目次（days）が記事本体に追いついているか
  const daysSnap = await db.collection('days').where(FieldPath.documentId(), '>=', since.slice(0, 8)).get();
  let dayEntries = 0;
  let dayLatest = '';
  let dayMax = 0;
  for (const d of daysSnap.docs) {
    const items = d.data().items ?? {};
    dayMax = Math.max(dayMax, Buffer.byteLength(JSON.stringify(items)));
    for (const e of Object.values(items)) {
      dayEntries++;
      if (e.p > dayLatest) dayLatest = e.p;
    }
  }
  log(`目次(days・10日): ${daysSnap.size}件のドキュメント / ${dayEntries}件 / 最新の配信 ${dayLatest} / 最大 約${Math.round(dayMax / 1024)}KB${dayLatest < latest ? '  ← 記事本体より古い（目次の更新を確認）' : ''}`);
  log(`日別: ${JSON.stringify(perDay)}`);
  log(`判定者: ${JSON.stringify(byModel)}`);
  log(`おすすめ度: ${JSON.stringify(byScore)}`);
  log(`要約あり: ${summarized} / 要約待ちの高: ${highNoSummary}`);
  log(`最大のバケット: ${maxDoc} 約${Math.round(maxBytes / 1024)}KB（上限 1MB）`);

  const usage = await db.collection('aiUsage').where(FieldPath.documentId(), '>=', jst(now, 8).slice(0, 6) + '01').get();
  log(`aiUsage: ${JSON.stringify(Object.fromEntries(usage.docs.map((d) => [d.id, d.data()])))}`);
  const dec = await db.collection('decisions').get();
  const saved = await db.collection('saved').count().get();
  log(`decisions: ${dec.size}日分 / saved: ${saved.data().count}件`);

  // 除外ルールの見直し材料：不要にした理由、ルールで除外された記事を戻した記録
  const all = [];
  for (const d of dec.docs) for (const [id, x] of Object.entries(d.data().d ?? {})) all.push({ id, ...x });
  const manualDrops = all.filter((x) => x.how === 'manual' && x.status === 'drop');
  const withReason = manualDrops.filter((x) => x.reason || (x.reasonTags ?? []).length);
  const tagCount = {};
  for (const x of withReason) for (const t of x.reasonTags ?? []) tagCount[t] = (tagCount[t] ?? 0) + 1;
  const restored = all.filter((x) => x.how === 'manual' && x.status !== 'drop' && (x.ruleIds ?? []).length);
  const cfg = (await db.doc('config/exclusion').get()).data();
  log(`除外ルールの設定: ${JSON.stringify(cfg ?? null)}`);
  log(`手動で不要: ${manualDrops.length}件（理由あり ${withReason.length}件） / 理由の選択肢: ${JSON.stringify(tagCount)}`);
  const recent = withReason.sort((a, b) => b.at - a.at).slice(0, 80);
  log('不要にした理由（新しい順）:\n' + (recent.map((x) => `- at=${x.at}｜${x.title}｜${x.company}｜[${(x.reasonTags ?? []).join(',')}] ${x.reason ?? ''}`).join('\n') || '（なし）'));
  log('ルールで除外された記事を戻した記録:\n' + (restored.map((x) => `- at=${x.at}｜[${x.ruleIds.join(',')}→${x.status}] ${x.title}｜${x.company}`).join('\n') || '（なし）'));
  const noReason = manualDrops.filter((x) => !(x.reason || (x.reasonTags ?? []).length)).sort((a, b) => b.at - a.at).slice(0, 40);
  log('理由なしで不要にした記事（新しい順・参考）:\n' + (noReason.map((x) => `- ${x.title}｜${x.company}`).join('\n') || '（なし）'));

  try {
    const errs = execSync(
      `gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR AND timestamp>="${new Date(now - 6 * 3600e3).toISOString()}"' --project=prtimes-inbox --limit=20 --format='value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)'`,
      { encoding: 'utf8' },
    ).trim();
    log(`直近6時間のエラー:\n${errs || '（なし）'}`);
  } catch (e) {
    log(`ログの取得に失敗: ${String(e).slice(0, 300)}`);
  }

  try {
    const res = await fetch('https://prtimes-inbox.web.app/');
    const html = await res.text();
    log(`公開ページ: HTTP ${res.status} / title=${(html.match(/<title>(.*?)<\/title>/) ?? [])[1]}`);
  } catch (e) {
    log(`公開ページの取得に失敗: ${e}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + out.join('\n') + '\n```\n');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

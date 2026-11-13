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

  for (const id of ['collector', 'backfill', 'backfillStore', 'ai', 'archive', 'profiles', 'gbiz']) {
    const d = (await db.doc(`meta/${id}`).get()).data();
    log(`meta/${id}: ${JSON.stringify(d ?? null)}`);
  }
  // 会社の台帳と、「読む」の後（AIの下書き・メモ・Knowledge Base への受け渡し）
  const count = async (c) => (await db.collection(c).count().get()).data().count;
  log(
    `台帳: companies ${await count('companies')}社 / companyArticles ${await count('companyArticles')}社 / 企業情報の読み込み待ち ${await count('profileQueue')}社`,
  );
  const cn = (await db.collection('companies').where('corporateNumber', '>', '').count().get()).data().count;
  log(`gBizINFO: 法人番号と結びついた会社 ${cn}社`);
  const draftDocs = await db.collection('drafts').get();
  const dstate = {};
  for (const d of draftDocs.docs) dstate[d.get('state')] = (dstate[d.get('state')] ?? 0) + 1;
  log(`AIの下書き: ${JSON.stringify(dstate)} / メモ ${await count('notes')}件 / 受け渡し ${await count('handoff')}件`);
  for (const d of draftDocs.docs.filter((x) => x.get('state') === 'failed').slice(0, 5)) log(`  下書きの失敗: ${d.id} ${d.get('error')}`);

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
  // ここから下は、リポジトリが公開なので記録（Actions のログ）に出す中身を絞る：
  // 利用者が読んだ記事・不要にした記事のタイトルや理由は出さず、件数だけにする。
  // 例外は、夜中の見直しでルールを作る・直すのに必要な分（同じ理由が10件以上・戻した記録が2件以上）だけ。
  const RULE_MIN = 10;
  const RESTORE_MIN = 2;
  // 材料は「まだどのルールにも当たらない理由あり」と「ルールの最終更新日より後に戻した記録」。
  // ルールを作る・直すと材料から自然に外れるので、処理済みの時刻を数える必要はない
  const { EXCLUSION_RULES } = require(path.join(__dirname, '..', 'functions', 'lib', 'src', 'lib', 'exclusion.js'));
  const disabledRules = new Set(cfg?.disabledRules ?? []);
  const asArticle = (x) => ({ id: x.id, title: x.title ?? '', company: x.company ?? '', lead: '', keywords: [], section: '', ticker: '', url: '', publishedAt: '' });
  const covered = (x) => EXCLUSION_RULES.some((r) => !disabledRules.has(r.id) && r.test(asArticle(x)));
  const fresh = withReason.filter((x) => !covered(x)).sort((a, b) => b.at - a.at);
  const groups = {};
  for (const x of fresh) for (const k of (x.reasonTags ?? []).length ? x.reasonTags : ['（自由記入のみ）']) (groups[k] ??= []).push(x);
  log(`見直しの材料（どのルールにも当たらない「理由あり」${fresh.length}件）: ${JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])))}`);
  for (const [k, v] of Object.entries(groups))
    if (v.length >= RULE_MIN)
      log(`ルール化の候補「${k}」${v.length}件（${RULE_MIN}件以上）:\n` + v.map((x) => `- at=${x.at}｜${x.title}｜${x.company}${x.reason ? `｜${x.reason}` : ''}`).join('\n'));
  const byRule = {};
  for (const x of restored)
    for (const r of x.ruleIds) {
      const rule = EXCLUSION_RULES.find((e) => e.id === r);
      if (rule && x.at > new Date(`${rule.updated}T00:00:00+09:00`).getTime()) (byRule[r] ??= []).push(x);
    }
  log(`ルールで除外された記事を戻した記録（ルールの最終更新日より後）: ${JSON.stringify(Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, v.length])))}`);
  for (const [r, v] of Object.entries(byRule))
    if (v.length >= RESTORE_MIN) log(`直す候補のルール「${r}」${v.length}件（${RESTORE_MIN}件以上）:\n` + v.map((x) => `- at=${x.at}｜→${x.status}｜${x.title}`).join('\n'));
  // 直近の手動判定（判定画面・一覧のどちらも）は件数だけ
  const manual = all.filter((x) => x.how === 'manual');
  const last24 = manual.filter((x) => x.at >= now - 86400e3);
  const cnt = {};
  for (const x of last24) cnt[x.status] = (cnt[x.status] ?? 0) + 1;
  log(`直近24時間の手動判定: ${last24.length}件 ${JSON.stringify(cnt)}`);
  log(`理由なしで不要: ${manualDrops.length - withReason.length}件`);
  // 判定の根拠（決め手の言葉・ひとこと・理由のボタン）。件数だけ（言葉や文は出さない）
  const basis = { keep: { terms: 0, note: 0, tags: 0 }, drop: { terms: 0, note: 0, tags: 0 } };
  const termSet = { keep: new Set(), drop: new Set() };
  const tagCount2 = {};
  for (const x of manual) {
    const side = x.status === 'drop' ? 'drop' : x.status === 'keep' || x.status === 'done' ? 'keep' : null;
    if (!side) continue;
    if ((x.terms ?? []).length) basis[side].terms++;
    for (const w of x.terms ?? []) termSet[side].add(w);
    if (x.reason) basis[side].note++;
    if ((x.reasonTags ?? []).length) basis[side].tags++;
    for (const t of x.reasonTags ?? []) tagCount2[t] = (tagCount2[t] ?? 0) + 1;
  }
  log(
    `判定の根拠: 読む側 決め手${basis.keep.terms}件（言葉${termSet.keep.size}種）・ひとこと${basis.keep.note}件・理由${basis.keep.tags}件 / 不要側 決め手${basis.drop.terms}件（言葉${termSet.drop.size}種）・ひとこと${basis.drop.note}件・理由${basis.drop.tags}件 / 理由の内訳 ${JSON.stringify(tagCount2)}`,
  );

  try {
    const errs = execSync(
      `gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR AND timestamp>="${new Date(now - 6 * 3600e3).toISOString()}"' --project=prtimes-inbox --limit=20 --format='value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)'`,
      { encoding: 'utf8' },
    ).trim();
    log(`直近6時間のエラー:\n${errs || '（なし）'}`);
  } catch (e) {
    log(`ログの取得に失敗: ${String(e).slice(0, 300)}`);
  }
  // 台帳づくり・依頼の処理の直近の記録（警告以上と、各回の結果）
  try {
    const raw = execSync(
      `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name=("archivecompanies" OR "companyprofiles" OR "runjobseveryminute" OR "draftnotes") AND timestamp>="${new Date(now - 3 * 3600e3).toISOString()}" AND (severity>=WARNING OR jsonPayload.message=("archive run" OR "profile sweep" OR "jobs" OR "draft sweep"))' --project=prtimes-inbox --limit=30 --format=json`,
      { encoding: 'utf8', maxBuffer: 20e6 },
    );
    const rows = JSON.parse(raw || '[]').map((e) => {
      const msg = e.textPayload ?? JSON.stringify(e.jsonPayload ?? e.protoPayload?.status ?? {});
      return `${e.timestamp} ${e.severity} ${e.resource?.labels?.service_name} ${String(msg).slice(0, 300)}`;
    });
    log(`台帳づくり・依頼の処理（直近3時間）:\n${rows.join('\n') || '（なし）'}`);
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

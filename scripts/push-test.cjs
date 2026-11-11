// 毎朝の通知をすぐに1回送る（GitHub Actions の push-test ワークフローから実行）。登録できたかの確認用。
// DRY_RUN=1 なら送らずに内容だけ表示する。
const path = require('path');
const F = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib');
const { initializeApp } = require(path.join(F, 'app'));
const { getFirestore } = require(path.join(F, 'firestore'));
const { getMessaging } = require(path.join(F, 'messaging'));
const { morningMessage, morningSummary, sendToAll } = require(path.join(__dirname, '..', 'functions', 'lib', 'functions', 'src', 'morning.js'));

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

(async () => {
  const summary = await morningSummary(db, new Date());
  const msg = morningMessage(summary);
  console.log('集計:', JSON.stringify(summary));
  console.log('通知:', msg.title, '／', msg.body);
  const tokens = await db.collection('pushTokens').get();
  console.log('登録されている端末:', tokens.size, '台', tokens.docs.map((d) => d.data().device).join(', '));
  if (process.env.DRY_RUN === '1') return process.exit(0);
  const r = await sendToAll(db, getMessaging(), { title: `（テスト）${msg.title}`, body: msg.body });
  console.log('送信結果:', JSON.stringify(r));
  process.exit(r.tokens && !r.success ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

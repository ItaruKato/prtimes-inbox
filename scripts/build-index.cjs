// 目次（days）を、保存済みの全記事（buckets）から作り直す（GitHub Actions の build-index ワークフローから実行）。
// 新しい記事は取得処理が目次も書くので、普段は不要。目次の形を変えたとき・初回だけ使う。
const path = require('path');
const F = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib');
const { initializeApp } = require(path.join(F, 'app'));
const { getFirestore } = require(path.join(F, 'firestore'));
const { indexKey, toEntry } = require(path.join(__dirname, '..', 'functions', 'lib', 'src', 'lib', 'dayIndex.js'));

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

(async () => {
  const buckets = await db.collection('buckets').get();
  const byKey = new Map();
  let n = 0;
  for (const d of buckets.docs)
    for (const a of Object.values(d.data().items ?? {})) {
      if (!a.publishedAt || Number.isNaN(new Date(a.publishedAt).getTime())) continue;
      const k = indexKey(a.publishedAt);
      const m = byKey.get(k) ?? {};
      m[a.id] = toEntry(a);
      byKey.set(k, m);
      n++;
    }
  let maxBytes = 0;
  const keys = [...byKey.keys()].sort();
  for (let i = 0; i < keys.length; i += 20) {
    const batch = db.batch();
    for (const k of keys.slice(i, i + 20)) {
      const items = byKey.get(k);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(items)));
      batch.set(db.collection('days').doc(k), { items });
    }
    await batch.commit();
  }
  console.log(`目次を作りました: 記事 ${n}件 / ドキュメント ${keys.length}件 / 最大 約${Math.round(maxBytes / 1024)}KB`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

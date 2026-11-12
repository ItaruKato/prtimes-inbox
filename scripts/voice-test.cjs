// 音声メモの文字起こしの確認（GitHub Actions の voice-test ワークフローから実行）
// 1秒の無音の WAV で依頼（jobs）を1件出し、1分ごとの処理が受け取って終えるまで待つ。
// 無音なので文字は空になる。音声の書き起こし（Speech-to-Text）を呼べる権限があるかを確かめる。依頼は処理のあと1日で消える。
const path = require('path');
const F = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin', 'lib');
const { initializeApp } = require(path.join(F, 'app'));
const { getFirestore, Timestamp } = require(path.join(F, 'firestore'));

initializeApp({ projectId: 'prtimes-inbox' });
const db = getFirestore();

function silentWav(sec = 1, rate = 16000) {
  const n = sec * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

(async () => {
  const ref = db.collection('jobs').doc();
  const batch = db.batch();
  batch.set(ref.collection('parts').doc('0'), { n: 0, data: silentWav() });
  batch.set(ref, { type: 'transcribe', state: 'ready', title: '（確認用）', company: '', parts: 1, at: Timestamp.now() });
  await batch.commit();
  console.log(`依頼 jobs/${ref.id} を出しました。処理を待ちます（最大3分）`);
  const until = Date.now() + 180e3;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10e3));
    const j = (await ref.get()).data();
    if (j.state === 'done') {
      console.log('結果: 文字起こしを呼べました（無音なので文字は空）', JSON.stringify(j.result));
      return;
    }
    if (j.state === 'failed') {
      console.log('結果: 失敗', j.error);
      process.exit(1);
    }
    console.log(`  状態: ${j.state}`);
  }
  console.log('結果: 3分たっても処理されませんでした');
  process.exit(1);
})();

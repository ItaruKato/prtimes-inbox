import type Anthropic from '@anthropic-ai/sdk';
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { withLease } from './lease';
import { makeDraft, syncHandoff, tidyTranscript } from './notes';

/**
 * 画面からの依頼（jobs/{自動ID}）を1分ごとに処理する。
 * 画面から Cloud Functions を直接呼ばない（関数を外から呼べる状態にしない）ため、依頼はデータベース経由で受け取る。
 * - draft: 「読む」にした記事の AI の下書きを作る（redo: 作り直す）
 * - handoff: 読了・メモの保存のあとに Knowledge Base への受け渡しを書き直す
 * - transcribe: 話した音声（16kHz・モノラルの WAV。jobs/{ID}/parts/{n} に分けて保存）を文字に起こし、メモとして整える
 *   結果は jobs/{ID}.result に書き、音声は消す
 */
export interface Job {
  type: 'draft' | 'handoff' | 'transcribe';
  state: 'ready' | 'working' | 'done' | 'failed';
  id?: string;
  redo?: boolean;
  title?: string;
  company?: string;
  at?: Timestamp;
}

/** 音声（WAV）を文字に起こす。本番は Google Cloud Speech-to-Text */
export type Recognize = (wav: Buffer) => Promise<string>;

const ID_RE = /^\d+\.\d+$/;
const KEEP_MS = 24 * 3600e3;

async function claimJob(db: Firestore, ref: DocumentReference): Promise<Job | null> {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const j = s.data() as Job | undefined;
    if (!j || j.state !== 'ready') return null;
    tx.update(ref, { state: 'working', startedAt: Timestamp.now() });
    return j;
  });
}

async function deleteParts(ref: DocumentReference) {
  const parts = await ref.collection('parts').get();
  if (!parts.empty) {
    const b = ref.firestore.batch();
    for (const p of parts.docs) b.delete(p.ref);
    await b.commit();
  }
}

export async function runJobs(deps: {
  db: Firestore;
  client: () => Anthropic;
  recognize: Recognize;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}) {
  const { db } = deps;
  const r = await withLease(db, 'jobs', 290_000, async () => {
    const until = Date.now() + (deps.budgetMs ?? 230_000);
    const counts: Record<string, number> = {};
    // 音声は待っている人がいるので先に
    const ready = (await db.collection('jobs').where('state', '==', 'ready').limit(30).get()).docs.sort(
      (a, b) => Number(b.get('type') === 'transcribe') - Number(a.get('type') === 'transcribe'),
    );
    for (const d of ready) {
      if (Date.now() >= until) break;
      const job = await claimJob(db, d.ref);
      if (!job) continue;
      try {
        if (job.type !== 'transcribe' && !ID_RE.test(job.id ?? '')) throw new Error('記事IDが正しくありません');
        if (job.type === 'draft') {
          if (job.redo) await db.collection('drafts').doc(job.id!).delete();
          await makeDraft(db, deps.client(), job.id!, { log: deps.log });
          await d.ref.update({ state: 'done' });
        } else if (job.type === 'handoff') {
          await syncHandoff(db, job.id!);
          await d.ref.update({ state: 'done' });
        } else if (job.type === 'transcribe') {
          const parts = await d.ref.collection('parts').orderBy('n').get();
          const wav = Buffer.concat(parts.docs.map((p) => Buffer.from(p.get('data').toUint8Array?.() ?? p.get('data'))));
          if (!wav.length || wav.length > 2_500_000) throw new Error('音声がないか、長すぎます（1分まで）');
          const transcript = (await deps.recognize(wav)).trim();
          const text = transcript ? await tidyTranscript(deps.client(), db, transcript, { title: job.title, company: job.company }) : '';
          await d.ref.update({ state: 'done', result: { transcript, text } });
          await deleteParts(d.ref);
        } else {
          throw new Error(`知らない依頼です: ${String(job.type)}`);
        }
        counts[job.type] = (counts[job.type] ?? 0) + 1;
      } catch (e) {
        deps.log?.('job failed', { job: d.id, type: job.type, error: String(e) });
        await d.ref.update({ state: 'failed', error: String(e).slice(0, 300) });
        if (job.type === 'transcribe') await deleteParts(d.ref);
      }
    }
    // 1日たった依頼は消す（音声が残っていれば一緒に）
    const old = await db.collection('jobs').where('at', '<', Timestamp.fromMillis(Date.now() - KEEP_MS)).limit(100).get();
    for (const o of old.docs) {
      await deleteParts(o.ref);
      await o.ref.delete();
    }
    return { ...counts, cleaned: old.size };
  });
  if (!r.ran) return { skipped: true };
  if (Object.keys(r.value).some((k) => k !== 'cleaned') || r.value.cleaned) deps.log?.('jobs', r.value);
  return r.value;
}

import { addDoc, Bytes, collection, doc, onSnapshot, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { firebaseEnabled, getFirebase } from '../firebase';

/** AI の下書き（drafts/{記事ID}。Cloud Functions が書く） */
export interface Draft {
  state: 'working' | 'done' | 'failed';
  at: string;
  summary?: string;
  points?: { label: string; value: string }[];
  angles?: string[];
  fits?: { service: string; reason: string }[];
  memo?: string;
  industry?: string;
  error?: string;
}

/** 自分のメモ（notes/{記事ID}） */
export interface Note {
  memo?: string;
  myTags?: string[];
  stars?: number;
}

export function subscribeDraft(id: string, onData: (d: Draft | null) => void): () => void {
  if (!firebaseEnabled) return () => {};
  return onSnapshot(
    doc(getFirebase().db, 'drafts', id),
    (s) => onData((s.data() as Draft | undefined) ?? null),
    () => onData(null),
  );
}

export function subscribeNote(id: string, onData: (n: Note) => void): () => void {
  if (!firebaseEnabled) return () => {};
  return onSnapshot(
    doc(getFirebase().db, 'notes', id),
    (s) => onData((s.data() as Note | undefined) ?? {}),
    () => onData({}),
  );
}

export async function saveNote(id: string, n: Note): Promise<void> {
  await setDoc(doc(getFirebase().db, 'notes', id), { ...n, updatedAt: serverTimestamp() }, { merge: true });
}

/**
 * Cloud Functions への依頼（jobs）。サーバーが1分ごとに処理する
 * （画面から関数を直接呼ばない。外から呼べる入口を作らないため）。
 */
function addJob(data: Record<string, unknown>) {
  return addDoc(collection(getFirebase().db, 'jobs'), { ...data, state: 'ready', at: serverTimestamp() });
}

/** 「読む」にした記事の下書きを頼む（届かなかったときも、10分ごとの予備の処理が作る） */
export function requestDraft(id: string, redo = false): Promise<unknown> {
  if (!firebaseEnabled) return Promise.resolve();
  return addJob({ type: 'draft', id, redo }).catch((e) => console.warn('requestDraft', e));
}

/** Knowledge Base への受け渡しを書き直してもらう（読了・メモの保存のあと） */
export function refreshHandoff(id: string): Promise<unknown> {
  if (!firebaseEnabled) return Promise.resolve();
  return addJob({ type: 'handoff', id }).catch((e) => console.warn('refreshHandoff', e));
}

/** 1つのドキュメントに入れる音声の大きさ（Firestore の上限 1 MiB に収める） */
const PART_BYTES = 800_000;

/** 話した音声を文字に起こし、メモとして整えてもらう（結果が出るまで待つ。ふつう1分ほど） */
export async function transcribe(wav: Uint8Array, ctx: { title: string; company: string }): Promise<{ transcript: string; text: string }> {
  const { db } = getFirebase();
  const ref = doc(collection(db, 'jobs'));
  const batch = writeBatch(db);
  const n = Math.ceil(wav.length / PART_BYTES);
  for (let i = 0; i < n; i++)
    batch.set(doc(ref, 'parts', String(i)), { n: i, data: Bytes.fromUint8Array(wav.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)) });
  batch.set(ref, { type: 'transcribe', state: 'ready', title: ctx.title, company: ctx.company, parts: n, at: serverTimestamp() });
  await batch.commit();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('時間がかかっています。少したってから開き直してください'));
    }, 180_000);
    const unsub = onSnapshot(
      ref,
      (s) => {
        const j = s.data() as { state?: string; result?: { transcript: string; text: string }; error?: string } | undefined;
        if (j?.state === 'done') {
          clearTimeout(timer);
          unsub();
          resolve(j.result ?? { transcript: '', text: '' });
        } else if (j?.state === 'failed') {
          clearTimeout(timer);
          unsub();
          reject(new Error(j.error ?? '失敗しました'));
        }
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---- 録音（最大55秒）→ 16kHz・モノラルの WAV ----

export const MAX_RECORD_SEC = 55;

export async function startRecording(): Promise<{ stop: () => Promise<Uint8Array> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start();
  return {
    async stop(): Promise<Uint8Array> {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
      return toWav16k(blob);
    },
  };
}

async function toWav16k(blob: Blob): Promise<Uint8Array> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  void ctx.close();
  const rate = 16000;
  const len = Math.min(Math.ceil(decoded.duration * rate), rate * (MAX_RECORD_SEC + 1));
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

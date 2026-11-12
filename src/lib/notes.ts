import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
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

/** Cloud Functions の関数を呼ぶ（firebase/functions は使うときだけ読み込む） */
async function call<T>(name: string, data: unknown): Promise<T> {
  const { getFunctions, httpsCallable } = await import('firebase/functions');
  const fn = httpsCallable(getFunctions(getFirebase().app, 'asia-northeast1'), name, { timeout: 170_000 });
  return (await fn(data)).data as T;
}

/** 「読む」にした記事の下書きを頼む（失敗しても、10分ごとの予備の処理が作る） */
export function requestDraft(id: string, redo = false): Promise<unknown> {
  return call('requestDraft', { id, redo }).catch((e) => console.warn('requestDraft', e));
}

/** Knowledge Base への受け渡しを書き直してもらう（読了・メモの保存のあと） */
export function refreshHandoff(id: string): Promise<unknown> {
  return call('refreshHandoff', { id }).catch((e) => console.warn('refreshHandoff', e));
}

/** 話した音声を文字に起こし、メモとして整えてもらう */
export function transcribe(wavBase64: string, ctx: { title: string; company: string }): Promise<{ transcript: string; text: string }> {
  return call('transcribeMemo', { audio: wavBase64, ...ctx });
}

// ---- 録音（最大55秒）→ 16kHz・モノラルの WAV ----

export const MAX_RECORD_SEC = 55;

export async function startRecording(): Promise<{ stop: () => Promise<string> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start();
  return {
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
      return toWav16k(blob);
    },
  };
}

async function toWav16k(blob: Blob): Promise<string> {
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
  // base64 にする（大きいので少しずつ）
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

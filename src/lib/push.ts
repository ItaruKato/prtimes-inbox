import { deleteDoc, doc, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';
import type { FirebaseApp } from 'firebase/app';

/** この端末で通知を受け取れるか */
export type PushState = 'on' | 'off' | 'denied' | 'ios-browser' | 'unsupported';

const LS_TOKEN = 'prt-push-token';

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

function savedToken(): string | null {
  try {
    return localStorage.getItem(LS_TOKEN);
  } catch {
    return null;
  }
}

export function pushState(): PushState {
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  // iPhone は、ホーム画面に追加したアプリから開いたときだけ通知を使える
  if (isIOS() && !isStandalone()) return 'ios-browser';
  if (!supported) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && savedToken() ? 'on' : 'off';
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 通知を許可してもらい、この端末を通知先として登録する（ボタンを押したときに呼ぶ） */
export async function enablePush(app: FirebaseApp, db: Firestore): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { getMessaging, getToken } = await import('firebase/messaging');
  const token = await getToken(getMessaging(app), { serviceWorkerRegistration: reg });
  if (!token) throw new Error('通知の登録に失敗しました');
  await setDoc(doc(db, 'pushTokens', await sha256(token)), {
    token,
    createdAt: serverTimestamp(),
    device: isIOS() ? 'iPhone/iPad' : navigator.platform || 'browser',
    ua: navigator.userAgent.slice(0, 200),
  });
  try {
    localStorage.setItem(LS_TOKEN, token);
  } catch {
    /* 記憶できなくても登録はできている */
  }
  return 'on';
}

/** この端末の通知をやめる */
export async function disablePush(app: FirebaseApp, db: Firestore): Promise<PushState> {
  const token = savedToken();
  if (token) {
    await deleteDoc(doc(db, 'pushTokens', await sha256(token))).catch(() => {});
    const { deleteToken, getMessaging } = await import('firebase/messaging');
    await deleteToken(getMessaging(app)).catch(() => {});
  }
  try {
    localStorage.removeItem(LS_TOKEN);
  } catch {
    /* なし */
  }
  return 'off';
}

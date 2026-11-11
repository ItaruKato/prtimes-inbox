import { useState } from 'react';
import { disablePush, enablePush, isIOS, pushState, type PushState } from '../lib/push';
import { firebaseEnabled, getFirebase } from '../firebase';

const LS_DISMISS = 'prt-push-banner-dismissed';

/** 毎朝9時の通知の設定。banner は受信箱の上に出す案内（未設定のときだけ） */
export function NotifyBox({ banner }: { banner?: boolean }) {
  const [state, setState] = useState<PushState>(() => pushState());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(LS_DISMISS) === '1';
    } catch {
      return false;
    }
  });
  if (!firebaseEnabled) return null;
  if (banner && (state === 'on' || state === 'unsupported' || dismissed)) return null;

  const run = async (f: typeof enablePush) => {
    setBusy(true);
    setErr(null);
    try {
      const { app, db } = getFirebase();
      setState(await f(app, db));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const msg: Record<PushState, string> = {
    on: 'この端末で、毎朝9時の通知を受け取っています。',
    off: '毎朝9時に、前日の新着と未処理の件数をお知らせします。',
    denied: isIOS()
      ? '通知が許可されていません。iPhone の「設定」→「通知」→「PR Watcher」で許可してください。'
      : '通知が許可されていません。ブラウザのアドレス欄の左にある鍵のマーク →「通知」で許可してください。',
    'ios-browser': 'iPhone では、ホーム画面に追加したアプリから開くと通知を設定できます（Safari の共有ボタン →「ホーム画面に追加」）。',
    unsupported: 'このブラウザでは通知を受け取れません。',
  };

  return (
    <div className={banner ? 'notifybox banner' : 'notifybox'}>
      <b>毎朝9時の通知</b>
      <p>{msg[state]}</p>
      <div className="notifyacts">
        {state === 'off' && (
          <button className="btn primary" type="button" disabled={busy} onClick={() => run(enablePush)}>
            {busy ? '設定中…' : '通知を受け取る'}
          </button>
        )}
        {state === 'on' && !banner && (
          <button className="ghost" type="button" disabled={busy} onClick={() => run(disablePush)}>
            この端末では受け取らない
          </button>
        )}
        {banner && (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              setDismissed(true);
              try {
                localStorage.setItem(LS_DISMISS, '1');
              } catch {
                /* なし */
              }
            }}
          >
            あとで
          </button>
        )}
      </div>
      {err && <p className="err">通知の設定に失敗しました：{err}</p>}
    </div>
  );
}

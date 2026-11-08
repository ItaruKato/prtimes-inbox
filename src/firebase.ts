import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';

/**
 * Firebase コンソール →「プロジェクトの設定」→「マイアプリ」のウェブアプリの設定値。
 * ブラウザに配られる公開情報なので、リポジトリに置いてよい（アクセス制限は firestore.rules で行う）。
 * apiKey が空のあいだは試作データで動く。
 */
export const firebaseConfig = {
  apiKey: '',
  authDomain: 'prtimes-inbox.firebaseapp.com',
  projectId: 'prtimes-inbox',
  storageBucket: 'prtimes-inbox.firebasestorage.app',
  messagingSenderId: '',
  appId: '',
};

/** ログインを許可するGoogleアカウント（firestore.rules と同じ値にする） */
export const OWNER_EMAIL = 'i-kato@spark-partners.jp';

export const firebaseEnabled = Boolean(firebaseConfig.apiKey);

let app: FirebaseApp | undefined;
let db: Firestore | undefined;
let auth: Auth | undefined;

export function getFirebase() {
  if (!firebaseEnabled) throw new Error('Firebase の設定がありません');
  if (!app) {
    app = initializeApp(firebaseConfig);
    // 端末内にキャッシュし、2回目以降は差分だけ受け取る
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    auth = getAuth(app);
  }
  return { app, db: db!, auth: auth! };
}

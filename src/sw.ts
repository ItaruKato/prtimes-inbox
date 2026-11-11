/// <reference lib="webworker" />
// サービスワーカー：画面のファイルを端末に保存（オフラインでも開ける）＋毎朝の通知を表示する
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// ログインの処理（/__/auth/…）は横取りしない
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/__/] }));

// 新しい版はすぐに切り替える
self.skipWaiting();
clientsClaim();

interface PushPayload {
  notification?: { title?: string; body?: string; icon?: string };
  data?: Record<string, string>;
}

// 毎朝の通知（Firebase Cloud Messaging から届く）。iPhone では、届いた通知は必ず表示する必要がある
self.addEventListener('push', (event) => {
  let p: PushPayload = {};
  try {
    p = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    p = { notification: { body: event.data?.text() } };
  }
  const title = p.notification?.title ?? p.data?.title ?? 'PR Times Watcher';
  const body = p.notification?.body ?? p.data?.body ?? '新着があります';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'morning',
      data: { url: p.data?.url ?? '/' },
    }),
  );
});

// 通知を押したらアプリを開く（開いていれば前に出す）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) if ('focus' in w) return (w as WindowClient).focus();
      return self.clients.openWindow(url);
    })(),
  );
});

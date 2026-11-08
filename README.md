# PR Times Watcher

PR TIMES の新着プレスリリースを集め、AIのおすすめ度で振り分けて読むための自分専用アプリ。
iPhone（ホーム画面に追加）・Windows・Mac のブラウザで使う。

## いまの状態

- 画面（React + TypeScript + Vite、PWA対応）: 試作データ300件で動作
- `?stress=1` を付けると 3,000件/日×2日 の負荷テスト用データで動く
- 振り分け状態はブラウザ内に保存（Firebase 接続後は全端末で同期）

## 決まっている仕様

| 項目 | 内容 |
|---|---|
| 取得対象 | PR TIMES の全記事（最大 3,000件/日を想定） |
| 取得頻度 | 1時間ごと（RSS ＋ ニュース用サイトマップ、会社名は会社IDでキャッシュ） |
| 振り分け | AIのおすすめ度「高」→ 受信箱、「中」→ 候補、「低」と新作ゲーム → 不要 |
| 注目テーマ | 資金調達・上場・M&A・新規事業・マーケティング（企業規模・業界は問わない） |
| 学習 | 手動の「不要」と「候補から拾った記事」をClaudeの判定例として使う（まとめて不要は弱めに反映） |
| 保存期間 | 「読む」記事は無期限、それ以外は一定期間で削除 |
| 通知 | 毎朝9時に、前日までの「高」の未読件数をiPhoneに通知 |
| 基盤 | Firebase（Hosting / Firestore / Cloud Functions / Auth）＋ Claude API |

## 開発

```bash
npm install
npm run dev
```

## 構成

- `src/data/repo.ts` データ入出力の境界。`mockRepo.ts` を Firestore 版に差し替える予定
- `src/lib/mockJudge.ts` 仮のAI判定（キーワード一致）。本番は取得処理でClaudeが判定
- `src/state/useTriage.ts` 振り分け状態・件数集計・元に戻す
- `src/components/` 画面部品

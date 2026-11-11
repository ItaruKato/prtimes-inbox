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
| 取得頻度 | 30分ごと（毎時5分・35分。RSS ＋ ニュース用サイトマップ、会社名は会社IDでキャッシュ） |
| 振り分け | 新作ゲームの案内だけを自動で「不要」へ、それ以外はすべて受信箱（AIのおすすめ度判定はいったん停止中。`src/lib/flags.ts` と `functions/src/index.ts` のフラグで再開できる） |
| 注目テーマ | 資金調達・上場・M&A・新規事業・マーケティング（企業規模・業界は問わない） |
| 学習 | （AI判定の再開時）手動の「不要」と「候補から拾った記事」をClaudeの判定例として使う（まとめて不要は弱めに反映） |
| 保存期間 | すべて無期限（`functions/src/cleanup.ts` の RETENTION_DAYS）。画面の表示期間は直近3日・7日・10日・全期間から選べる |
| 通知 | 毎朝9時に、前日までの未読件数をiPhoneに通知（未実装） |
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

## 運用（自動除外ルール）

| いつ | 何が | どこで見る |
|---|---|---|
| 毎晩 2:48 | 自動セッションが「不要にした理由」をもとにルールを見直す（同じ種類が10件以上でルール化。`docs/rule-review.md` の手順） | `docs/rule-review-log.md`、iPhone の通知 |
| 毎週月曜 7:30 | `rule-report` ワークフローがルールごとの週次集計を `ruleReports` に保存 | アプリの「ルールの点検」画面 |
| 毎週月曜 7:49 | 自動セッションが週次集計を点検し、注意点を報告（変更はしない） | iPhone の通知 |
| 必要なとき | `rule-check` ワークフローでルール案を本番の全記事に当てて試す（読み取りのみ） | GitHub Actions のログ |

- ルールの定義とテストは `src/lib/exclusion.ts` と `src/lib/exclusion.test.ts`（デプロイ前に `npm test` で確認）
- ルールのオン・オフはアプリのルール一覧のチェックで切り替え（`config/exclusion` に保存）

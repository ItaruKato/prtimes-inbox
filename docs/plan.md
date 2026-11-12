# 今後の開発計画（知識・ロングリスト）

> 新しいチャット（Long List・Knowledge Base）はまずこのファイルを読む。特に「共有の決まり（上書き事故を防ぐ）」は必ず守る。

## アプリ構成（3つ。同じ Firebase プロジェクトで会社の台帳を共有）
- **PR Times Watcher**（入口）：判定 → 読む → 読了。「読む」にした時点で AI が要点とメモの下書き。修正可、音声入力（話す → 文字起こし → AI が整える）
- **会社の台帳**（裏側）：PR TIMES に出た日本企業（上場・非上場）を法人番号で名寄せ。PR TIMES 企業ページ・会社HP・Web検索＋AI で業界タグ（営業向け独自分類 30〜50種）、事業内容、代表者、所在地、代表電話。過去1年分の記事もさかのぼる
- **Long List**：台帳の全社をタグで並べ替え・絞り込み。温度感 A/B/C は AI が理由付きで提案 → 本人が確定。進捗：未着手 → アプローチ中 → 商談 → 受注／対象外
- **Knowledge Base**：全記事（読んだ記事とメモを優先）。テーマ別ネタ帳、先行事例（業界・テーマ・規模/段階・課題・狙い）、会社ページ、アプリ内の質問、Claude のチャットから質問（MCP）

## レポート
- デイリー：毎朝9時（今の通知とまとめる）。昨日の注目記事＋今日の営業ネタ。アプリ＋メール
- ウィークリー：日曜21時。アプリ＋メール

## 方針
- 最初は本人のみ。後で社外パートナーを招待（人ごとに見せる範囲を選ぶ。Google＋メールリンクでログイン）
- 連絡先は会社の代表電話・代表者名のみ（個人の連絡先は集めない）
- 予算は精度優先、使った額は毎週報告
- 順番：①Watcher の読了と受け渡し → ②会社の台帳 → ③Long List → ④Knowledge Base

## 本人からもらうもの
- 国税庁 法人番号 Web-API のアプリケーションID、gBizINFO API のトークン（保管は Secret Manager。チャットに貼らない）
- 4つの商材（経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援）の中身
- あとで答えてほしい質問 5〜10個、Long List で見たい項目

## 進み具合
- [x] ①Watcher：「既読」を「読了」に。「読む」にした記事に AI の下書き（要点・営業トークの切り口・相性のよいサービス・メモ）、メモの編集、音声メモ（話す → 文字起こし → AI が整える）、重要度★、自分用タグ
- [x] Watcher の判定の対象を 2026-09-01 からに（はじめ 10-01、のちに 09-01 へ広げた）（backfill。画面は直近7日分を先に出し、古い分はあとから読み足す）
- [x] ②台帳の準備：記事ページの「企業情報」（URL・業種・本社所在地・電話番号・代表者名・上場・資本金・設立）を companies に。過去1年分（2025-11-01〜）の記事を会社ごとに companyArticles へ
- [x] gBizINFO：会社名と所在地（都道府県）で検索し、1社に決まったら法人番号・代表者・資本金・従業員数・設立・事業内容を companies に（gbiz・corporateNumber・gbizMatch）
- [ ] 法人番号API（国税庁）：申請済み・アプリケーションIDの到着待ち（1か月ほど）。gBizINFO で決まらなかった会社の名寄せに使う
- [ ] ③Long List
- [ ] ④Knowledge Base（ItaruKato/knowledge、https://prtimes-knowledge.web.app）：ひな形・自動デプロイ・`kb` のルールまで。計画と決まったことは knowledge の `docs/plan.md`

## データの置き場所（Knowledge Base・Long List から読む）
| コレクション | 中身 | 書く人 |
|---|---|---|
| `handoff/{記事ID}` | 読了にした記事の受け渡し：`v`（形式の版=1）、`article`（タイトル・会社・URL・配信日時・本文冒頭）、`readAt`、`memo`、`myTags`、`stars`（0〜3）、`draft`（AIの要点：summary・points・angles・fits・memo・industry）、`updatedAt` | Cloud Functions |
| `drafts/{記事ID}` | AIの下書き（state: working / done / failed） | Cloud Functions |
| `notes/{記事ID}` | 自分のメモ（memo・myTags・stars） | 画面 |
| `companies/{会社ID}` | name、profile（url・industry・address・phone・representative・listed・capital・established）、profileAt、corporateNumber、gbiz（gBizINFO：representative・capital・employees・established・url・summary など）、gbizMatch（name / core / name+address / none / ambiguous）、gbizAt、gbizInsured（厚生年金の被保険者数：total・offices・updated）、gbizFinance（有価証券報告書の主要な経営指標：year・period・sales・ordinaryIncome・netIncome・netAssets・totalAssets・capital は { raw, unit, yen }、employees）、gbizExtraAt | Cloud Functions |
| `companyArticles/{会社ID}` | name、a.{記事ID} = { t: タイトル, p: 配信日時 } | Cloud Functions |
| `profileQueue/{会社ID}` | 企業情報の読み込み待ち | Cloud Functions |
| `jobs/{自動ID}` | 画面からの依頼（draft・handoff・transcribe）。1分ごとに処理し、1日で消す。画面から関数を直接呼ばない（外から呼べる入口を作らない）ため | 画面（依頼）・Cloud Functions（結果） |
| `kbArticles`・`kbBodies`・`kbCompanies`・`kbThemes`・`kbReports`・`kbMeta` | Knowledge Base が整理した記事・会社・テーマ・レポート（ItaruKato/knowledge） | Knowledge Base の Cloud Functions |
| `kbJobs/{自動ID}`・`kbConfig/{doc}` | Knowledge Base の画面からの依頼（質問など）と画面の設定 | Knowledge Base の画面（依頼・設定）・Cloud Functions（結果） |

会社IDは PR TIMES の会社ID（記事IDの後ろの数字）。法人番号での名寄せは、申請が通ったあとに companies に `corporateNumber` を足す。

## 会社の台帳で取れる項目（2026-11-12 時点）
| 出どころ | 項目 | どれくらい埋まるか |
|---|---|---|
| PR TIMES の記事ページ「企業情報」（`companies.profile`） | URL・業種（PR TIMES の大分類）・本社所在地・電話番号・代表者名・上場（未上場など）・資本金・設立 | 企業情報を読み終えた会社のほぼ全部（見つからない会社は3回まで読み直す） |
| gBizINFO（`companies.gbiz`） | 法人番号・正式名・フリガナ・所在地・代表者・資本金・従業員数・設立日・創業年・HP・事業概要・事業項目・閉鎖日 | 最初の120社で約75%（1社に決まらない 5%・見つからない 20%） |
| gBizINFO の事業所情報（`companies.gbizInsured`） | 厚生年金・健康保険の被保険者数（日本年金機構の適用事業所検索システムを gBizINFO が半年ごとに取り込んだもの。全喪していない事業所の合計）。従業員数とは違う（短時間のパートは入らず、役員は入る） | 法人番号が決まった会社のうち、厚生年金の適用事業所。180日ごとに読み直す |
| gBizINFO の財務情報（`companies.gbizFinance`） | 売上高・経常利益・当期純利益・純資産・総資産・資本金・従業員数（EDINET の有価証券報告書。最新の回） | 有価証券報告書を出す会社（上場企業と一部の大きな会社）だけ |
| 会社ごとの記事（`companyArticles`） | 2025-11-01 以降の全記事のタイトル・配信日時（本文は `buckets` の記事、2026-09-01 以降のみ） | 全社 |
| AIの下書き（`drafts` / `handoff`） | 本人が「読む」にした記事の要点・営業トークの切り口・相性のよいサービス・業界（仮） | 「読む」にした記事だけ |

- 名寄せ：gBizINFO は「名前（法人格を含む）が一致」→「法人格を除いた名前が一致」→ 同名が複数なら所在地（市区町村まで）で絞る。決まらなければ結びつけない（`gbizMatch` に none / ambiguous）。
- 国税庁の法人番号API（届くのは 2026-12 中旬の見込み）で、none / ambiguous の会社を補う。取得元の表示が必要：「このサービスは、国税庁法人番号システムのWeb-API機能を利用して取得した情報をもとに作成しているが、サービスの内容は国税庁によって保証されたものではない」
- gBizINFO の情報を画面に出すときは出典を表示する。利用規約（2026-11-12 確認。政府標準利用規約 2.0 準拠）：商用を含め自由に利用できる。出典の例「出典：「Gビズインフォ」（経済産業省）（ページのURL）」。編集・加工したときはその旨も書く（例「「Gビズインフォ」（経済産業省）をもとに作成」）。国が作ったように見せない。
- 非上場の会社の売上・BS は、無料の公的なデータではほぼ取れない（gBizINFO の決算情報は官報掲載のうち公開を許諾した法人だけ）。有料のデータは Long List のチャットで比べて本人が決める。
- 業界タグ（営業向け独自分類 30〜50種）は未作成。PR TIMES の業種・gBizINFO の事業概要・記事から AI で付ける予定（Long List の最初の仕事の候補）。

## Long List（③）で決まっていること
- 対象：PR TIMES に出た日本企業の全社（上場・非上場。自治体・大学・団体・海外企業は除く）。重複なし（PR TIMES の会社ID → 法人番号でまとめる）
- 並べ替え・絞り込み：業界タグ・テーマ（資金調達・上場・M&A・新規事業・マーケ）・規模・地域・最新の記事の日付・温度感・進捗。それぞれソートできるようにタグを付ける
- 温度感 A/B/C：AI が4つのサービスとの相性から理由付きで提案 → 本人が確定
- 進捗：未着手 → アプローチ中 → 商談 → 受注／対象外
- 連絡先：会社の代表電話・代表者名のみ（広報担当者など個人の連絡先は集めない）
- 見たい項目の詳細は「あとで整理」（本人）
- 最初は本人だけ。後で社外パートナーを招待し、人ごとに見せる範囲を選ぶ（Google＋メールリンクでログイン）

## Knowledge Base（④）で決まっていること
- 用途：営業でのトーク、先行事例のインプット、会社のインプット
- 範囲：全記事（`buckets`・`companyArticles`）。本人が読んだ記事（`handoff`）とメモを優先して使う
- 取り出し方：テーマ別のネタ帳、アプリ内で質問すると記事を根拠に答える、Claude のチャットから質問（MCP）、デイリー（毎朝9時：昨日の注目記事＋今日の営業ネタ）・ウィークリー（日曜21時）をアプリ＋メールで
- 先行事例の切り口：業界・テーマ・規模/段階・課題/狙い
- 会社ページ：PR TIMES 記事の時系列、調達・M&A の履歴、会社の基本情報、自分のメモと接点
- 音声メモ・AI の下書きは Watcher で作る（Knowledge Base は受け取って整理する側）

## Long List と Knowledge Base の分担（2026-11-12 本人が決定。二重に作らない）
- **業界タグ（営業向け独自分類 30〜50種）**：分類表とタグを付ける処理は台帳側（このリポジトリの functions）に1つだけ置き、`companies/{会社ID}` に書く。Long List・Knowledge Base は読むだけ。**作るのは Long List のチャット**（Watcher・台帳の処理を足すので、作る前に本人に中身を相談する）。Knowledge Base はそれまで AI の仮の業界（`drafts.industry` など）を使い、できたら切り替える。
- **売上・決算公告（会社 HP・記事から AI で拾う）**：業界タグと同じく台帳側の処理として `companies` に書く（出どころの URL と年度付き）。作るのは Long List のチャット（2026-11-12 本人が決定）。まず200社で試してから全社に広げる。官報は規約で機械的な収集が禁止なので読まない。
- **会社ページ**：Knowledge Base が持つ。住所は `https://prtimes-knowledge.web.app/c/{会社ID}`（会社IDは PR TIMES の会社ID＝companies のドキュメントID）。Long List は自分の会社ページを作らず、このリンクで飛ぶ。Knowledge Base の会社ページは `longlist/{会社ID}` の `temperature`（A/B/C）と `progress`（未着手／アプローチ中／商談／受注／対象外）を読んで表示する（読むだけ）。Long List でこの名前を変えるときは、ここも直す。`longlist` のルールが入るまでは表示しない。
- **コレクション名**：Knowledge Base は `kb` で始まる名前、Long List は `longlist` で始まる名前だけに書く。
- **見た目**：共通の部品は作らず、Watcher の `src/index.css` の色・文字の決まり（`:root` の変数）をそれぞれ写してそろえる。
- **自動デプロイの許可**：Workload Identity のプロバイダの条件は `ItaruKato/prtimes-inbox`・`ItaruKato/longlist`・`ItaruKato/knowledge` の3つ（本人が設定済み）。書き直すときは3つとも残す。`roles/iam.workloadIdentityUser` は prtimes-inbox と knowledge に付いている（longlist は自分の分を本人に足してもらう）。

## 共有の決まり（上書き事故を防ぐ）
同じ Firebase プロジェクト `prtimes-inbox`（asia-northeast1）を3つのアプリで使う。次を守らないと、ほかのアプリの本番を消したり上書きしたりする。
1. **Firestore のルールと索引は `ItaruKato/prtimes-inbox` の `firestore.rules`・`firestore.indexes.json` だけで管理する。** 新しいアプリのコレクション（例：`longlist`）のルール・索引も、このリポジトリに足してデプロイする。ほかのリポジトリからは Firestore をデプロイしない（Watcher のデプロイは `--force` なので、ファイルにない索引は消える）。
2. **Cloud Functions は codebase を分ける。** 新しいリポジトリの `firebase.json` の functions に `"codebase": "longlist"` のように別の名前を付け、デプロイは `--only functions:longlist,hosting:longlist` に限る（同じ codebase だと、Watcher の関数が「ソースにない」として消される）。
3. **Hosting は別のサイトにする。** 例：`firebase hosting:sites:create prtimes-longlist` → `https://prtimes-longlist.web.app`。`firebase.json` の hosting に `"target"` を付け、`.firebaserc` で結びつける（同じサイトに出すと Watcher の画面が上書きされる）。
4. **ログインの許可ドメインを足す。** Firebase コンソール → Authentication → 設定 → 承認済みドメインに、新しいサイトのドメイン（例：`prtimes-longlist.web.app`）を足す（本人の操作）。
5. **自動デプロイの許可を足す（本人が Cloud Shell で1回）。** いまの GitHub Actions の認証（Workload Identity）は `ItaruKato/prtimes-inbox` の main だけを許可している（`scripts/setup-gcp.sh`）。新しいリポジトリから出すには、プロバイダの条件に新しいリポジトリを足し、`github-deploy@prtimes-inbox.iam.gserviceaccount.com` にそのリポジトリの `roles/iam.workloadIdentityUser` を付ける。権限の変更なので、Claude は自分で付けず、コマンドを案内して本人に実行してもらう。
6. **画面から関数を直接呼ばない。** 誰でも呼べる関数（allUsers の呼び出し許可）は作らない。画面からの依頼は Firestore（例：`jobs`）に書き、スケジュールの関数が処理する（Watcher の `functions/src/jobs.ts` と同じ形）。
7. **秘密情報は Secret Manager だけ。** いまあるもの：`ANTHROPIC_API_KEY`（Claude）、`GBIZINFO_TOKEN`（gBizINFO）。法人番号の ID は届いたら `HOUJIN_APP_ID` にする予定。チャット・リポジトリ・ログに値を出さない。トークンを入れ直したら、使う関数をデプロイし直す（デプロイ時の版を使い続けるため）。
8. **リポジトリは公開。** Actions のログ・コミット・docs に、本人が読んだ記事・不要にした記事・メモ・営業先の情報を出さない（件数だけ）。メモや下書き、台帳の中身もログに出さない。
9. **ログインは本人だけ（`i-kato@spark-partners.jp`、メール確認済み）。** 社外パートナーを入れるときは、ルールに役割（本人／パートナー）と見せる範囲を足す。
10. **書き込み先を分ける。** Long List・Knowledge Base は台帳（`companies` など）を読むだけにし、自分のデータは自分のコレクション（例：`longlist/{会社ID}`、`kb...`）に書く。台帳を直したいときは Watcher 側（このリポジトリ）の処理を直す。
11. コミットの作成者は `Claude <noreply@anthropic.com>`。モデル名はコミット・PR に書かない。

## 作業環境（Claude Code のクラウド）
- 環境「prtimes-inbox」：PR TIMES、国税庁（法人番号・インボイス公表サイト）、gBizINFO（サイト・API・ヘルプ）に接続できる。新しいチャットもこの環境を選ぶ。
- 本番の様子は `gh workflow run health.yml --repo ItaruKato/prtimes-inbox --ref main` のログで見る（件数中心）。

## 新しいチャットの始め方
- リポジトリは新しく作る（例：`ItaruKato/longlist`、`ItaruKato/knowledge`）。新しいチャットでは、新しいリポジトリと `ItaruKato/prtimes-inbox` の両方を選ぶ。
- 最初のメッセージの例：
  「○○アプリを作りたい。PR Times Watcher（ItaruKato/prtimes-inbox）と同じ Firebase プロジェクト prtimes-inbox の会社の台帳を使う、別のリポジトリ・別のサイトのアプリにする。まず prtimes-inbox の docs/plan.md を読んで、決まっていることと『共有の決まり』を確認してから、足りないことを質問形式でどんどん聞いて。私は素人なので、やることは手順を分かりやすく教えて。」

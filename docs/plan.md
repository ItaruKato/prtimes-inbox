# 今後の開発計画（知識・ロングリスト）

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
- [x] ②台帳の準備：記事ページの「企業情報」（URL・業種・本社所在地・電話番号・代表者名・上場・資本金・設立）を companies に。過去1年分（2025-11-01〜）の記事を会社ごとに companyArticles へ
- [ ] 法人番号・gBizINFO での名寄せ（申請の結果待ち）
- [ ] ③Long List ／ ④Knowledge Base

## データの置き場所（Knowledge Base・Long List から読む）
| コレクション | 中身 | 書く人 |
|---|---|---|
| `handoff/{記事ID}` | 読了にした記事の受け渡し：`v`（形式の版=1）、`article`（タイトル・会社・URL・配信日時・本文冒頭）、`readAt`、`memo`、`myTags`、`stars`（0〜3）、`draft`（AIの要点：summary・points・angles・fits・memo・industry）、`updatedAt` | Cloud Functions |
| `drafts/{記事ID}` | AIの下書き（state: working / done / failed） | Cloud Functions |
| `notes/{記事ID}` | 自分のメモ（memo・myTags・stars） | 画面 |
| `companies/{会社ID}` | name、profile（url・industry・address・phone・representative・listed・capital・established）、profileAt | Cloud Functions |
| `companyArticles/{会社ID}` | name、a.{記事ID} = { t: タイトル, p: 配信日時 } | Cloud Functions |
| `profileQueue/{会社ID}` | 企業情報の読み込み待ち | Cloud Functions |

会社IDは PR TIMES の会社ID（記事IDの後ろの数字）。法人番号での名寄せは、申請が通ったあとに companies に `corporateNumber` を足す。

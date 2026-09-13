# GPT Connector

[![npm version](https://img.shields.io/npm/v/gpt-connector.svg)](https://www.npmjs.com/package/gpt-connector)
[![license](https://img.shields.io/npm/l/gpt-connector.svg)](LICENSE)

Claude・Codex・Grok・Cursorから、ログイン済みChatGPT公式Web runtimeの通常Chatと画像生成を呼び出すローカルconnector。

[kitepon.dev](https://kitepon.dev/)のクオが開発・メンテナンスしています。

## 所有境界

本repositoryはinstall、MCP設定、Chrome runtime、job/session、state、schema／migration、添付、
diagnostics、recovery、update、releaseを所有します。単独cloneでもこのrepository内のREADMEと
[`docs/README.md`](docs/README.md)だけで導入・運用・復旧・公開まで完結します。
[dotagents](https://github.com/kitepon/dotagents)は任意の工場統合、host別wire、製品間compatibilityと
統合受入を担当しますが、gpt-connectorの運用を制御せず、実行時の必須依存でもありません。
正規MCP IDは`gpt_connector`です。
MarkItDownは別区分の第三者CLIです。

ブラウザは認証・integrity・attestation・conversation lifecycleの実行環境として使う。composer、送信button、回答DOM、React fiberは操作・参照しない。

> [!WARNING]
> consumer Chatの非公開Web runtimeとminified bundleに依存する実験的実装。OpenAIの公開・安定APIではない。bundle contractが変わった場合は`RUNTIME_DRIFT`で停止し、別方式へ自動fallbackしない。

現在ソース版は`gpt-connector@0.7.0`。`setup`がnpm導入・MCP登録・ブラウザ準備・診断を所有します。
通常Chatは指定を省略すると「最新」の右端を使います。選べる段階は`chatgpt_models`のlive catalogで確認します。公開済みversionは
[npm](https://www.npmjs.com/package/gpt-connector)、ソースと変更履歴は
[GitHub repository](https://github.com/kitepon/gpt-connector)を正とします。

## 成立済み機能

- 通常Chatのone-shot送信と自動archive。
- 受付時に返す会話IDによる複数turn継続。専用Chromeのpageを保持すればMCP再接続後も利用できる。
- explicit closeとserver archive read-back。
- Webの「最新」と一致する5段階の選択と、省略時の右端選択。
- live catalog取得と、既存のmodel／thinking effort明示選択。
- ChatGPT通常枠の画像生成、Library相関read-back、安全なローカル保存。
- Work-only modelの除外。
- 非対応model／effortの送信前拒否。
- 全regular fileのChatGPT正規添付。known extensionは標準MIME、unknown extensionは`application/octet-stream`。
- workspaceRoot境界、glob、MIME、size、秘密file denylistの送信前検証。
- 256KiB CDP chunk転送とpage側SHA-256照合。
- server attachment metadata read-backとモデル読取確認。
- caller既知slugによるconsult冪等性、terminal result回収、owner-only durable job台帳。
- upload／conversationを作らないdry-run、既存diagnostics、factory diagnostics。
- CLIとstdio MCP adapter。

## 前提

- Node.js 22以上とnpm（macOS・Windows・Linux）。
- liveブラウザ機能にはmacOS、Google Chrome、ChatGPTへログインできるaccount。
- Windowsの操作シェルはPowerShell 7。

sourceからbuildする場合だけpnpm 11以上も必要。

## 導入・更新

```bash
npx --yes gpt-connector@latest setup
```

初回も更新も同じ入口を使う。実行した版を公式npmでglobal installしてから、導入済みCLIへ処理を引き継ぐ。
Claude・Codex・Grok・Cursorのユーザー設定へ`gpt_connector`を登録し、MCP initialize／7 tools／診断応答とstate読取りを確認する。
既存command、args、env、モデル、認証、他MCP、利用者のtimeout・無効化・ツール制限は保持する。
変更前の設定は`~/.gpt-connector/setup-backups/`へtarで保存する。

Macでは既存の`startBrowser`／`showBrowser`が専用Chromeを準備する。ログインが必要なら画面を表示し、
`action_required`で停止する。そのChromeで手動ログインしてから同じコマンドを再実行する。
パスワード入力や認証challengeの自動化はしない。

導入済み版での再実行と、読み取り専用の診断:

```bash
gpt-connector setup
gpt-connector setup --check
```

| 機能 | macOS | Windows / Linux |
| --- | --- | --- |
| npm導入・4AIへのMCP登録 | 対応 | 対応 |
| MCP initialize・tools list・診断応答 | 対応 | 対応 |
| `sessions`による既存job読取り・state診断 | 対応 | 対応 |
| 専用Chrome起動・live model・Chat・画像・添付 | 対応 | 未対応 |

`setup`は`ready`で終了0、ログイン待ち・失敗で終了1、非Macで対応機能の確認が済みliveだけ未対応なら
`partial`で終了2を返す。`registrations`のAI別結果を読み、未対応を成功として扱わない。
各AIは新しいセッションで設定を読み込む。setupのMCP確認と、既存AIセッションへの反映は別の確認項目である。

対象AIや既存Codex project設定を指定できる。

```bash
gpt-connector setup --ai claude,codex,grok,cursor
gpt-connector setup --ai codex --codex-config /absolute/project/.codex/config.toml
```

詳しい保存先、停止条件、移行契約は[AI installer向けセットアップ契約](docs/ai-installer-setup-contract.md)を参照。

### 専用Chromeの運用

`browser start`は正規専用PIDだけをAppKit `hidden`へ移し、公式origin・認証・page bridge・WindowServer表示window 0件を確認する。
cold startでは窓なしChromeのCDP browser endpointからbackground ChatGPT targetを作る。
CDP `minimized`は作成時のhintだけで、非表示の最終判定には使わない。通常ChromeやOracle profileは使用しない。

`gpt-connector browser show`は正規専用PIDを表示し、unhiddenかつ表示window 1件以上を確認する。
Chrome更新時のsmokeは`browser start`、`models`、hidden中の`chat`、必要時の`browser show`で行う。

## source setup

```bash
git clone https://github.com/kitepon/gpt-connector.git
cd gpt-connector
pnpm install
pnpm check
pnpm build
```

read-only model smoke:

```bash
gpt-connector models --endpoint http://127.0.0.1:9223
```

one-shot Chat smoke:

```bash
gpt-connector chat \
  --endpoint http://127.0.0.1:9223 \
  --prompt '「確認済み」とだけ返信してください'
```

`--level 高`のように段階名を指定できます。`--level`を省略すると「最新」の右端を使います。

CLIの`chat`はone-shot専用。`consult` jobはdurable台帳へ残るため、別processの`sessions`から回収できる。複数turnの会話sessionはMCP adapterを使う。

ChatGPT通常枠で画像を生成してworkspaceへ保存する。この経路はOpenAI APIを呼ばず、
`OPENAI_API_KEY`も使わない。利用可否と生成枠は、専用ChromeへログインしたChatGPT accountのplanに従う。

```bash
gpt-connector image \
  --endpoint http://127.0.0.1:9223 \
  --workspace-root "$PWD" \
  --output 'assets/generated/ad.png' \
  --prompt '白い背景に珊瑚色の円を置いた縦長広告素材' \
  --slug image-ad-001 \
  --model gpt-5-6-thinking \
  --effort min
```

caller timeout後は同じ画像promptを再送せず、`sessions --slug image-ad-001`でterminal stateを回収する。

正規添付のdry-run:

```bash
gpt-connector consult \
  --endpoint http://127.0.0.1:9223 \
  --workspace-root "$PWD" \
  --file 'docs/*.md' \
  --prompt '添付資料を監査してください' \
  --slug review-001 \
  --level 高 \
  --dry-run
```

`--dry-run`を外すと、検証済みbytesをChatGPTへ正規添付して通常Chatへ送る。caller timeout後は同じconsultを作り直さず、次で回収する。

```bash
gpt-connector sessions --slug review-001
```

診断:

```bash
gpt-connector doctor
gpt-connector --version
```

`doctor`は`gpt-connector.diagnostics.v1` JSONを返します。接続可能なら`overall: "ready"`、CDPや認証などが未準備なら`overall: "not_ready"`と安定`reasonCode`をstdoutへ返し、exit codeは非0です。診断はChromeの表示状態を変えず、uploadや会話作成も行いません。

## 更新・復旧・release

通常更新は公式npm packageだけを使います。更新後はversionと診断を確認し、Chromeを重複起動しません。

```bash
npx --yes gpt-connector@latest setup
gpt-connector setup --check
```

`doctor`が`cdp_unavailable`なら`browser start`を使います。`auth_required`なら`browser show`で専用Chromeを表示し、そこで手動ログインします。
`runtime_drift`なら製品更新または製品側修理が正規復旧です。別APIや通常Chromeへfallbackしません。
caller timeout後のconsult／画像jobは同じslugを再送せず、`sessions --slug <slug>`で既存jobを回収します。
process再起動前の非terminal jobは`JOB_RECOVERY_UNAVAILABLE`となり、自動再送しません。

releaseの唯一の手順とgateは[`docs/release.md`](docs/release.md)を正とします。工場へ切り離しても、
version同期、検証、main着地、npm公開、tag／GitHub Release、公開後smokeはこのrepositoryだけで実行できます。

## BugHub factory 契約

既存の `doctor` と別に、factory consumer 用の versioned read-only JSON を提供します。

```bash
gpt-connector factory-diagnostics --json
gpt-connector runtime-errors diagnostics --json
gpt-connector runtime-errors snapshot --after-cursor 0 --limit 256 --json
```

`factory-diagnostics` は package version、既存 diagnostics schema、overall、consult job の
state/job schema と migration、CDP、official origin、auth、runtime bridge、stdio MCP contractを
固定 check ID で返します。Chrome/CDP/auth が未準備なら `not_ready`、live connector を提供しない
host は `unsupported`、検査できない項目は `unverified` です。いずれも upload、conversation、archive、
job 作成を行いません。

`runtime-errors` は product-owned local aggregate であり、network I/O は実装しません。canonical
dotagents factory config（POSIX: `~/.config/dotagents/factory-reporter.json`、Windows native:
`%LOCALAPPDATA%\\dotagents\\factory-reporter\\config.json`）が厳密な JSON shape で
`collection.enabled: true` の場合だけ collection を開始します。設定なし・不正設定・
`reporting.enabled`・token/credentialの存在は collection を有効にしません。既定はOFFです。

公開操作はすべて `--json` 必須です。

```bash
gpt-connector runtime-errors snapshot --json
gpt-connector runtime-errors diagnostics --json
gpt-connector runtime-errors ack 12 --json
gpt-connector runtime-errors resolve <sha256-fingerprint> --json
gpt-connector runtime-errors reopen <sha256-fingerprint> --json
gpt-connector runtime-errors compact --json
```

recordは固定 code/template、SHA-256 fingerprint、count、first/last seen、status、cursorだけを持ちます。
ack cursor は単調で、compact は retention を過ぎた resolved かつ ack 済み recordだけを削除します。
stateは製品所有directoryへ owner-only atomic writeし、symlink・権限 drift・schema改ざんを拒否します。
prompt、assistant response、file名/内容/digest、conversation/session/job ID、cookie/token、CDP dump、
絶対path、生stack/stderrは入力・保存・出力できません。

## AIクライアントとMCP

Claude・Codex・Grok・Cursorへの登録は`setup`が担当する。Codexの既定登録先はユーザー設定。
trusted projectの`.codex/config.toml`へ登録済みの場合は`--codex-config`にその絶対pathを指定する。
Codexへ不足時に補う設定の例（既存値は優先する）:

```toml
[mcp_servers.gpt_connector]
command = "gpt-connector-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 240
enabled = true
required = false
enabled_tools = ["chatgpt_models", "chatgpt_chat", "chatgpt_image", "chatgpt_close", "consult", "sessions", "diagnostics"]

[mcp_servers.gpt_connector.env]
GPT_CONNECTOR_CDP_ENDPOINT = "http://127.0.0.1:9223"
# 任意。未指定時は $XDG_STATE_HOME/gpt-connector、
# XDG_STATE_HOME未設定時は ~/.local/state/gpt-connector
GPT_CONNECTOR_STATE_DIR = "/absolute/product-owned/state/gpt-connector"
```

設定の正本はOpenAI公式の[Model Context Protocol設定](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml)。

1. `npx --yes gpt-connector@latest setup`を実行する。
2. ログインを求められたら専用Chromeでログインし、同じ入口を再実行する。
3. 対象AIを新しいセッションで起動する。Codex project設定ではそのprojectを開く。
4. `chatgpt_models`でlive catalogを確認する。
5. second opinionはcaller既知slugを付けて`consult`を呼ぶ。
6. 画像生成はcaller既知slug、model、absolute `workspaceRoot`、relative `output`を付けて`chatgpt_image`を呼ぶ。
7. timeout時は再送せず、同じslugを`sessions`へ渡す。
8. 継続相談は`keepOpen=true`で会話を保持し、同じ`sessionId`と新しい`slug`で追加質問する。最後に`chatgpt_close`を呼ぶ。

MCP tools（すべてOpenAI ChatGPT専用。`consult`／`sessions`／`diagnostics`はtool名が中立だが、
Claude・Gemini等へのsecond opinionやcaller環境の診断には使えない。server instructionsと
各tool descriptionでもこの境界を宣言している）:

- `chatgpt_models`: 「最新」の順序付き`levels`、右端の`defaultLevel`と`defaultModel`、互換用model／effort一覧。
- `chatgpt_chat`: 新規またはsession継続。既定`keepOpen=false`で応答後archive。
- `chatgpt_image`: 通常枠で画像を生成し、同一turnのLibrary fileを検証してworkspaceへ保存。
- `chatgpt_close`: sessionをarchiveしてhandleを破棄。deleteは行わない。
- `consult`: slug冪等化、会話の継続、任意の正規添付、`level`選択、dry-runを持つsecond opinion入口。`wait=false`は回答完了前に受付結果を返す。
- `sessions`: exact slug 1件の状態／sessionId／terminal resultを返す。uploadや会話を作らず、connector未起動時は台帳を直接読む。
- `diagnostics`: 接続、bridge build、job／session／operation／upload buffer件数だけを返すread-only診断。

`diagnostics`は専用Chrome未接続時も`gpt-connector.diagnostics.v1`の`not_ready`結果を正常応答として返し、
read-only診断だけでruntime errorを記録しない。`chatgpt_models`、Chat、consult、画像生成など実操作の
接続失敗は、引き続きruntime-error storeへ記録する。

正規server IDは`gpt_connector`。既存の別名登録はsetupが削除・改名しない。

### 同じChatGPT会話で相談を続ける

初回の`consult`で前提を伝え、`keepOpen=true`と`wait=false`を指定する。

```json
{"slug":"design-review-001","prompt":"この設計の前提は……。問題点を検討して。","keepOpen":true,"wait":false}
```

受付結果は`state="running"`、`result=null`と会話の`sessionId`を返す。回答は`sessions({"slug":"design-review-001"})`で取得する。
`succeeded`を確認したら、返されたIDと新しいslugで追加質問する。

```json
{"slug":"design-review-002","sessionId":"初回に返されたUUID","prompt":"その2案の保守費用を比較して。","keepOpen":true,"wait":false}
```

同じ会話に送った前提や資料の再送は不要。変更点と追加質問だけを渡せる。最後は`chatgpt_close({"sessionId":"初回に返されたUUID"})`で閉じる。
`slug`は1問い合わせの重複防止ID、`sessionId`は複数問い合わせで共有する会話ID。
`wait`の既定は`true`で、従来どおり回答完了まで待つ。`wait=false`でも結果の自動通知は行わない。
CLIは回答完了まで待ち、`consult --keep-open`で得たIDを次回の`consult --session-id <uuid> --keep-open`へ渡せる。

## attachment contract

- `workspaceRoot`はabsolute directory、`files`はそこからのrelative pathまたはglob。
- spec順、glob内POSIX path順、realpath first occurrenceで決定的に解決する。
- absolute file path、`..`、root外symlink、directory、empty fileを拒否する。
- regular fileは形式を問わず元bytesのまま公式uploadへ渡す。一般的なtext、image、PDF、Office、archive、audio、videoには標準MIME、未知拡張子には`application/octet-stream`を使う。localで内容解析・変換は行わず、ChatGPTが解釈できる形式かは公式runtimeが判断する。
- 最大20 file、20MiB/file、64MiB total。
- `.env*`、key／certificate、credential／secret名など明白な秘密fileをoverrideなしで拒否する。
- ChatGPTへ渡すのはbytes、basename、MIMEだけ。ローカルabsolute pathはpage contextやtool resultへ渡さない。
- upload済みfileの削除手段は未成立。結果は`retention=unknown`、`cleanup=not_supported`と返し、archiveをfile cleanupとは表現しない。
- OpenAI公式は一般的なtext、spreadsheet、presentation、documentを対応対象として例示する一方、`.gdoc`は非対応としている。pass-through可能であることは、モデルが内容を解釈できる保証ではない。

詳細は[`docs/native-attachment-contract.md`](docs/native-attachment-contract.md)。

## image generation contract

- `model`は必須。live catalogにないmodel／effortへfallbackせず、runtimeのresolved model／effortが
  requested selectionと完全一致しない場合も`MODEL_RESOLUTION_MISMATCH`で失敗する。
- connectorが画像生成を明示する指示を加え、実画像が生成されなければ`IMAGE_NOT_GENERATED`で失敗する。
- Libraryの「最新画像」は使わない。server conversationの同一`turn_exchange_id`／`working_turn_id`に属する
  tool messageと、Libraryの`origination_thread_id`／`origination_message_id`が一致した画像だけを回収する。
- MIME、byte数、dimensions、SHA-256をpage側とNode側で照合し、256KiB chunkで転送する。
- `workspaceRoot`はabsolute directory、`output`はその配下のrelative `.png`／`.jpg`／`.jpeg`／`.webp` path。
- root外path／symlink、MIMEと拡張子の不一致、既存file上書きを拒否する。複数枚は`name-2.png`のように保存する。
- local保存とdigest再検証が完了してから、生成元だけをChatGPT LibraryのRecently Deletedへ移す。
  成功時は`retention=recently_deleted`／`cleanup=soft_deleted`、失敗時は`library`／`failed`、
  複数枚の一部だけ成功した場合は`mixed`／`partial`を返す。

## 最新の段階／model／effort contract

- `chat`と`consult`は、`level`・`model`・`effort`を省略すると「最新」のスライダー右端を選ぶ。
- catalogは公式`/models`の`versions[id=latest].intelligence_presets`を取得し、配列順を保つ。段階IDで並べ替えない。
- 段階名は`chatgpt_models`の`levels[].level`から選び、`level`へ渡す。内部model／effortへの変換はconnectorが所有する。
- 各presetの`model_slug`と、定義されている`thinking_effort`だけを送る。effortが無いpresetに値を補わない。
- 右端が利用不可なら`MODEL_NOT_AVAILABLE`、最新の定義を取得できなければ`RUNTIME_DRIFT`で止まる。
- 既存の明示`model`／`effort`指定は互換入口として維持し、`level`との併用を拒否する。effort指定時はmodelも必須。
- 明示effortは対象modelのlive `thinking_efforts`と完全一致させる。`is_work_mode_model=true`は通常Chatから除外する。
- 実行結果のmodelと指定したeffortを照合し、不一致は`MODEL_RESOLUTION_MISMATCH`で失敗する。別モデルや下位段階へ自動変更しない。
- `serviceTier`は別軸で、初期版では指定しない。

## session contract

- session IDはconnector生成のopaque UUID。
- server conversation IDやclient thread IDを含まない。
- `keepOpen=true`の会話は専用Chromeのpage bridgeが保持する。MCP切断・再接続後も同じIDで継続・closeできる。
- page再読込、Chrome終了、bridge更新でIDは無効になる。`SESSION_NOT_FOUND`を返し、新規会話への自動置換は行わない。
- `consult`は`keepOpen=true`で受付時からsnapshot直下に`sessionId`を保存する。成功結果の`result.sessionId`も同じ値。
- 次の質問は前の質問の成功後に送る。生成失敗時も受付IDは記録に残るが、初回生成の失敗では会話が破棄される。
- 同一sessionへの並行turnは`SESSION_BUSY`。
- one-shotと`chatgpt_close`はserverの`is_archived=true`をread-backしてから成功を返す。
- delete機能はない。

`consult`／`chatgpt_image` jobは別契約:

- callerが`^[a-z0-9][a-z0-9._-]{2,63}$`のslugを事前指定する。
- 同slug／同fingerprintは既存snapshotを返し、再upload／再送しない。
- 同slugへ異なるinputは`JOB_CONFLICT`。
- stateは`queued | uploading | submitted | running | succeeded | failed`。
- terminal jobはowner-only JSONへatomic保存し、process再起動後も`sessions`で回収できる。
- 再起動前の非terminal jobは完了有無を断定せず`JOB_RECOVERY_UNAVAILABLE`へ固定し、自動再送しない。
- 台帳はversion 2。version 1も読め、初回書込み前に`consult-jobs.json.v1-backup`へ元の台帳を保存する。旧版へ戻す条件は[CHANGELOG](CHANGELOG.md)の0.7.0を参照。

## failure codes

- `INVALID_INPUT`
- `AUTH_REQUIRED`
- `CDP_UNAVAILABLE`
- `RUNTIME_DRIFT`
- `MODEL_NOT_AVAILABLE`
- `EFFORT_NOT_SUPPORTED`
- `MODEL_RESOLUTION_MISMATCH`
- `FILE_NOT_FOUND`
- `FILE_OUTSIDE_ROOT`
- `SENSITIVE_FILE_BLOCKED`
- `FILE_TYPE_NOT_SUPPORTED`
- `FILE_EMPTY`
- `FILE_LIMIT_EXCEEDED`
- `UPLOAD_FAILED`
- `UPLOAD_TIMEOUT`
- `ATTACHMENT_READBACK_FAILED`
- `IMAGE_NOT_GENERATED`
- `IMAGE_READBACK_FAILED`
- `IMAGE_DOWNLOAD_FAILED`
- `IMAGE_OUTPUT_FAILED`
- `IMAGE_CLEANUP_FAILED`
- `CHAT_FAILED`
- `STREAM_INCOMPLETE`
- `SESSION_NOT_FOUND`
- `SESSION_BUSY`
- `ARCHIVE_FAILED`
- `JOB_NOT_FOUND`
- `JOB_CONFLICT`
- `JOB_RECOVERY_UNAVAILABLE`

## 秘密情報とログ

- cookie、authorization、access／refresh token、integrity、attestation、conduit tokenを取得・保存しない。
- CDP生dumpを保存しない。
- server conversation IDをtool resultやlogへ出さない。
- prompt、file本文、absolute pathをlogやjob台帳へ保存しない。
- terminal assistant responseはcaller timeout後の回収に必要なため、fingerprint／状態／結果とともにowner-only job台帳へ保存する。
- 画像job台帳はrelative出力path、MIME、byte数、dimensions、SHA-256だけを保存し、Library ID、conversation ID、content URL、absolute pathを保存しない。
- job台帳は製品所有state directoryに置き、他ツールの管理directoryやhookへ便乗しない。
- `.browser-profile/`、log、temporary dumpはgit管理外。

## architecture

```text
AI client ──stdio MCP──> resolver／job store ──> GptConnector core ──raw CDP──> ChatGPT page main world
                            │                                      │
                            └─ slug status                         ├─ official upload client
                                                                   ├─ builder／sender
                                                                   ├─ Library／server turn read-back
                                                                   └─ verified image chunk download
```

runtime roleは上限付きasset import graph、function source signature、object method shape、read-only catalog probeで一意検出する。候補が0件または複数なら実行しない。DOM selector、file input、React fiber、座標操作は本番経路に含まない。

## license

MIT

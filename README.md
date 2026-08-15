# GPT Connector

[![npm version](https://img.shields.io/npm/v/gpt-connector.svg)](https://www.npmjs.com/package/gpt-connector)
[![license](https://img.shields.io/npm/l/gpt-connector.svg)](LICENSE)

Codex開発枠から、ログイン済みChatGPT公式Web runtimeの通常Chatと画像生成を呼び出すローカルconnector。

[kitepon.dev](https://kitepon.dev/)を運営する[クオ（@QLyun35332）](https://x.com/QLyun35332)が
開発・メンテナンスしています。

## 所有境界

本repositoryはChrome runtime、job/session、添付、release、diagnosticsを所有します。
正規MCP ID `gpt_connector`、導入、host統合は、kitepon.devの製品開発を支える内部基盤
[dotagents](https://github.com/kitepon-rgb/dotagents)が担当します。
MarkItDownは別区分の第三者CLIです。

ブラウザは認証・integrity・attestation・conversation lifecycleの実行環境として使う。composer、送信button、回答DOM、React fiberは操作・参照しない。

> [!WARNING]
> consumer Chatの非公開Web runtimeとminified bundleに依存する実験的実装。OpenAIの公開・安定APIではない。bundle contractが変わった場合は`RUNTIME_DRIFT`で停止し、別方式へ自動fallbackしない。

現在ソース版は`gpt-connector@0.4.14`。公開済みversionは[npm](https://www.npmjs.com/package/gpt-connector)、ソースと変更履歴は[GitHub repository](https://github.com/kitepon/gpt-connector)を正とする。

## 成立済み機能

- 通常Chatのone-shot送信と自動archive。
- process内opaque sessionによる複数turn継続。
- explicit closeとserver archive read-back。
- live model catalog取得。
- model／thinking effort明示選択。
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

- macOS
- Google Chrome
- Node.js 26以上
- ChatGPTへログインできるaccount

sourceからbuildする場合だけpnpm 11以上も必要。

## npm global install

```bash
npm install --global gpt-connector
```

専用Chromeを起動する。通常ChromeとOracle profileは使用しない。
true headlessは使わず、cold startでは窓なしで専用profileのheadful Chromeを起動する。CDP browser endpointからbackground ChatGPT targetを作成し、target/windowの存在とschemaを確認する。画面非表示の正本はCDPの`windowState`ではなく、正規専用PIDのAppKit `hidden`状態とWindowServer layer 0 window数である。

`browser start`は正規専用PIDだけをhiddenへ移行し、ChatGPTの公式origin、認証、page bridge、WindowServer表示window 0件を確認してから成功を返す。CDPのwindow state要求が成功応答後も収束しないChromeでも、実画面状態を優先する。別profileや別PIDへは作用しない。

認証が必要になった場合だけwindowを表示へ戻す。手動でログイン／確認するには次を使う。

表示／非表示の最終判定は正規PIDのWindowServer layer 0 window数で行う。start成功時は0、show成功時は1件以上である。Chrome 150ではCDPの`normal`／`minimized`要求が成功応答を返しても`maximized`から変化しない実例を確認したため、CDP stateだけを可視性の証拠にしない。

```bash
gpt-connector browser show
```

Chrome更新時はrelease smokeとして`browser start`、`models`、最小化中の`chat`、必要時の`browser show`を確認する。

```bash
gpt-connector browser start
```

初回だけ、開いた専用ChromeでChatGPTへ手動ログインする。connectorはpassword、cookie、tokenを読み出さない。

### AI installer向けセットアップ

CodexなどのAIが導入する場合は、[AI installer向けセットアップ契約](docs/ai-installer-setup-contract.md)に従う。AIはinstall、専用Chrome起動、read-only診断、MCP設定を担当し、人間には専用ChromeでのChatGPTログインだけを依頼する。通常ChromeやOracleのprofile、認証情報は使用しない。

## source setup

```bash
git clone https://github.com/kitepon-rgb/gpt-connector.git
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
  --model gpt-5-6-thinking \
  --effort min \
  --prompt 'Reply with exactly: OK'
```

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
  --model gpt-5-6-thinking \
  --effort extended \
  --dry-run
```

`--dry-run`を外すと、検証済みbytesをChatGPTへ正規添付して通常Chatへ送る。caller timeout後は同じconsultを作り直さず、次で回収する。

```bash
gpt-connector sessions --slug review-001
```

read-only診断:

```bash
gpt-connector doctor
gpt-connector --version
```

`doctor`は`gpt-connector.diagnostics.v1` JSONを返します。接続可能なら`overall: "ready"`、CDPや認証などが未準備なら`overall: "not_ready"`と安定`reasonCode`をstdoutへ返し、exit codeは非0です。診断はuploadや会話作成を行いません。

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

## Codex MCP

Codexはtrusted projectの`.codex/config.toml`を読み、stdio serverは`command`と`env`で構成できる。npm global install後は、利用するprojectへ次の設定を置く。

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

1. `npm install --global gpt-connector`を実行する。
2. 専用Chromeを起動してログインする。
3. `.codex/config.toml`を置いたprojectで新しいCodex taskを開く。
4. `chatgpt_models`でlive catalogを確認する。
5. second opinionはcaller既知slugを付けて`consult`を呼ぶ。
6. 画像生成はcaller既知slug、model、absolute `workspaceRoot`、relative `output`を付けて`chatgpt_image`を呼ぶ。
7. timeout時は再送せず、同じslugを`sessions`へ渡す。
8. 既存互換の複数turnで`keepOpen=true`を使った場合は、最後に`chatgpt_close`を呼ぶ。

MCP tools（すべてOpenAI ChatGPT専用。`consult`／`sessions`／`diagnostics`はtool名が中立だが、
Claude・Gemini等へのsecond opinionやcaller環境の診断には使えない。server instructionsと
各tool descriptionでもこの境界を宣言している）:

- `chatgpt_models`: 通常Chat model／effort一覧。
- `chatgpt_chat`: 新規またはsession継続。既定`keepOpen=false`で応答後archive。
- `chatgpt_image`: 通常枠で画像を生成し、同一turnのLibrary fileを検証してworkspaceへ保存。
- `chatgpt_close`: sessionをarchiveしてhandleを破棄。deleteは行わない。
- `consult`: slug冪等化、任意の正規添付、model／effort、dry-runを持つsecond opinion入口。
- `sessions`: exact slug 1件の状態／terminal resultを返す。uploadや会話を作らず、connector未起動時は台帳を直接読む。
- `diagnostics`: 接続、bridge build、job／session／operation／upload buffer件数だけを返すread-only診断。

`diagnostics`は専用Chrome未接続時も`gpt-connector.diagnostics.v1`の`not_ready`結果を正常応答として返し、
read-only診断だけでruntime errorを記録しない。`chatgpt_models`、Chat、consult、画像生成など実操作の
接続失敗は、引き続きruntime-error storeへ記録する。

移行期間にCodex側のMCP server idを`oracle`へすれば、tool名は`oracle.consult`／`oracle.sessions`になる。別adapter packageやOracleへの自動fallbackは使わない。

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

## model／effort contract

- catalogは毎回公式`/models` runtimeから取得する。
- `is_work_mode_model=true`は通常Chatから除外する。
- model未指定なら公式defaultへ委ねる。
- effort指定時はmodel指定も必須。
- effortは対象modelのlive `thinking_efforts`と完全一致させる。
- 非対応組合せをdefaultへfallbackしない。
- `serviceTier`は別軸で、初期版では指定しない。

## session contract

- session IDはconnector生成のopaque UUID。
- server conversation IDやclient thread IDを含まない。
- sessionはMCP server process memory限定。process再起動後は継続できない。
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
Codex ──stdio MCP──> resolver／job store ──> GptConnector core ──raw CDP──> ChatGPT page main world
                            │                                      │
                            └─ slug status                         ├─ official upload client
                                                                   ├─ builder／sender
                                                                   ├─ Library／server turn read-back
                                                                   └─ verified image chunk download
```

runtime roleは上限付きasset import graph、function source signature、object method shape、read-only catalog probeで一意検出する。候補が0件または複数なら実行しない。DOM selector、file input、React fiber、座標操作は本番経路に含まない。

## license

MIT

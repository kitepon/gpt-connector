# AI installer向けセットアップ契約

## 目的

AI installerが`gpt-connector`を安全かつ再現可能に導入し、人間にはChatGPTへの手動ログインだけを依頼するための契約。人間向けの説明は[README](../README.md)を正とし、この文書はAIが実行順、停止条件、完了条件を機械的に判断するために使う。

## 前提

- 対象OSはmacOS。
- Google Chromeがインストール済みである。
- Node.js 22以上とnpmが利用できる。
- オーナーがChatGPTへログインできるaccountを持つ。
- connector用Chrome profileは`$HOME/.gpt-connector/browser-profile`、CDP endpointは`http://127.0.0.1:9223`を既定とする。

前提を満たさない場合、AI installerは不足項目を報告して停止する。依頼されていないsystem packageのinstallやaccount作成へ進まない。

## セットアップ手順

### 1. installとversion確認

オーナーがversionを指定した場合はそのversionを使う。指定がない場合はnpmのlatestを使い、解決されたversionを報告する。

```bash
npm install --global gpt-connector
gpt-connector --version
```

version指定時:

```bash
gpt_connector_version="0.4.19" # オーナーが指定したversionへ置き換える
npm install --global "gpt-connector@$gpt_connector_version"
gpt-connector --version
```

### 2. 現在状態の診断

```bash
gpt-connector doctor
```

`overall`が`ready`なら専用Chromeを重複起動せず、手順4へ進む。`doctor`はuploadやconversationを作らない。
`auth_required`では、正規専用Chromeだけを表示へ戻してから診断JSONを返す。

### 3. 専用Chromeの準備

`reasonCode`が`cdp_unavailable`の場合だけ、次で専用Chromeを起動する。

```bash
gpt-connector browser start
```

起動後に`gpt-connector doctor`を再実行する。初回診断または再診断の`reasonCode`が`auth_required`なら、
`doctor`が専用Chromeを表示済みである。AI installerは停止し、そのChromeでChatGPTへログインするよう人間へ依頼する。
ログイン完了の申告後、`doctor`を再実行する。

`browser start`はcold startでは窓なしChromeのCDP browser endpointからbackground ChatGPT targetを作成・確認し、正規専用PIDをAppKit `hidden`へ移してからapp readyを待つ。既存endpointでもapp ready probeより先に正規専用PIDをhiddenへ移す。target作成、hidden遷移または確認に失敗した場合、AI installerは成功扱いせず停止する。

`browser start`の成功返却時点では正規専用PIDはhiddenで、WindowServer layer 0の表示windowは0件である。`AUTH_REQUIRED`時だけ同じ専用PIDをunhideしてwindowを表示へ戻してから停止する。人間が手動で表示へ戻す必要がある場合は`gpt-connector browser show`を使う。Chrome更新時はrelease smokeとして`browser start`、`models`、hidden中の`chat`、必要時の`browser show`を確認する。

CDPの`minimized`指定はcold target作成時のhintであり、公開する画面非表示状態ではない。ChromeがCDPのwindow state要求へ成功応答しても実状態が変わらない場合があるため、startとshowの最終判定には使わない。

`browser show`は`Page.bringToFront`を送った後、正規専用PIDだけをunhide／activateする。最終状態はAppKit `hidden`状態とWindowServer layer 0 on-screen window数で確認する。start成功時はhiddenかつ0件、show成功時はunhiddenかつ1件以上である。

AI installerはpassword、cookie、tokenを要求・取得・表示・保存しない。ログインformの入力や認証challengeの突破を自動化しない。

### 4. Codex MCP設定

このserverはログイン済みOpenAI ChatGPT専用であり、Claude・Gemini等他providerのmodelは扱えない。
`consult`／`sessions`／`diagnostics`はtool名が中立だが対象は同じで、他providerへのsecond opinionや
caller環境の診断には使えない。server instructionsと各tool descriptionが同じ境界を宣言する。

対象projectの既存`.codex/config.toml`を上書きせず、次のserver設定をmergeする。

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
```

consumerが明示的に別のstate directoryを必要とする場合だけ、project所有のabsolute pathを`GPT_CONNECTOR_STATE_DIR`へ設定する。他ツールの管理directoryやhookを流用しない。

設定後、そのprojectで新しいCodex taskを開く。既存taskへの動的反映を成功条件にしない。

## 完了条件

次のすべてを満たした時だけセットアップ成功と報告する。

- `gpt-connector --version`が解決済みversionを返す。
- `gpt-connector doctor`がexit code 0で終了する。
- 診断JSONが少なくとも次の値を持つ。

```json
{
  "overall": "ready",
  "reasonCode": "ready",
  "cdpConnected": true,
  "officialOrigin": true,
  "authenticated": true
}
```

- 対象projectの`.codex/config.toml`にMCP server設定が存在する。
- 新しいCodex taskから`diagnostics`または`chatgpt_models`を呼び出せる。

最後のMCP確認はread-only toolで行う。セットアップ確認のためにChat、upload、conversationを作成しない。

## reasonCode別の処理

| reasonCode | AI installerの処理 |
| --- | --- |
| `ready` | Chromeを再起動せず、未完了の設定だけを進める。 |
| `cdp_unavailable` | 専用Chromeを起動する。cold startでは窓なしChromeのbrowser CDPからbackground ChatGPT targetを作成し、正規専用PIDをhiddenへ移してからapp probeする。起動済みでも同じ順序を守る。ChatGPT page targetは1つにする。 |
| `auth_required` | `doctor`が表示した専用Chromeでの手動ログインを人間へ依頼し、完了申告まで停止する。 |
| `runtime_drift` | 非公開runtimeの互換性喪失として停止し、更新または製品側修正が必要と報告する。別方式へfallbackしない。 |
| `state_unavailable` | state directoryのpath、所有者、permissionを報告して停止する。台帳を無断削除しない。 |
| `connector_error` | 診断JSONと再現手順を保持して停止する。推測で成功扱いしない。 |

## 再実行と再起動

- セットアップ再実行時は最初に`doctor`を実行し、`ready`なら専用Chromeを追加起動しない。
- 専用Chromeを終了した後は、手順3の同じコマンドで再起動する。通常Chromeのprofileへ切り替えない。
- MCP設定は既存内容を保ったまま必要なkeyだけをmergeする。同じserver定義を重複追加しない。
- npm packageを更新した場合はversionと`doctor`を再確認する。

## 禁止事項

- 通常Chrome、Oracle、その他製品のbrowser profileをコピー・変更・再利用しない。
- ChatGPTのpassword、cookie、token、認証headerをpage外へ取り出さない。
- login、CDP、runtime driftの失敗を別APIやUI操作へ黙ってfallbackしない。
- セットアップ確認を理由にprompt送信、file upload、conversation作成を行わない。
- オーナーの依頼なしに既存MCP serverを削除・改名しない。

## AI installerの最終報告

成功時は、install済みversion、専用Chrome profile、CDP endpoint、`doctor`の主要5項目、変更したMCP設定fileを報告する。未完了時は、停止した手順、`reasonCode`、人間または製品側に必要な次の操作を明記する。

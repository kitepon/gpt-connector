# AI installer向けセットアップ契約

## 正規入口

初回導入・更新はこの一回の入口で行う。Node.js 22以上とnpmが前提。WindowsではPowerShell 7を使う。
live機能にはmacOSまたはWindowsとインストール済みGoogle Chrome、ChatGPT accountが必要。

```bash
npx --yes gpt-connector@latest setup
```

version指定時（指定版を変更して使う）:

```bash
gpt_connector_version="0.9.8"
npx --yes "gpt-connector@$gpt_connector_version" setup
```

`npx`から実行した版を公式npmでglobal installし、その導入先のCLIへ引き継ぐ。
global導入済みの同じCLIからの再実行ではnpm導入を繰り返さない。npxのcache pathをMCP登録へ残さない。
工場wrapper、daemon、dotagentsの設定代行は必要ない。

```bash
gpt-connector setup
gpt-connector setup --check
```

`--check`はnpm導入・設定書込み・browser start/showを実行しない。Chromeの表示状態も変えず、
現在の登録・MCP応答・state・live・Codex Steerの状態を診断する。setup確認のためにChat、upload、conversationは作らない。

MacとWindowsでCodexを登録する時は、同梱コードで公式Codex DesktopへのSteer接続も導入する。Aitermは不要。
`registrations[].codexSteer.status=restart_required`ならCodexを完全終了して再起動する。
公式キューと同期hookを使い、自分のhookだけを承認する。旧中継は新hookの読戻し後に解除し、他製品のhook・承認・起動設定を保持する。
所有ファイル・確認・解除は[Codexへの自動Steer](codex-steer.md)を参照。

## 対象AIと保存先

既定では4AIすべてを登録する。AI本体のインストールや認証は各AI製品が所有する。

| AI | 既定設定file | 別の設定先 |
| --- | --- | --- |
| Claude | `~/.claude.json` | `CLAUDE_CONFIG_DIR/.claude.json` |
| Codex | `~/.codex/config.toml` | `CODEX_HOME/config.toml`、または`--codex-config` |
| Grok | `~/.grok/config.toml` | `GROK_HOME/config.toml` |
| Cursor | `~/.cursor/mcp.json` | `CURSOR_HOME/mcp.json` |

```bash
gpt-connector setup --ai claude,codex,grok,cursor
gpt-connector setup --ai codex --codex-config /absolute/project/.codex/config.toml
gpt-connector setup --check --ai codex --codex-config /absolute/project/.codex/config.toml
```

従来のREADMEに従いproject単位のCodex設定を作った環境では、同じfileを`--codex-config`へ渡す。
ユーザー設定とproject設定を無断で統合・削除しない。同一端末の共有AI設定を他製品の導入と同時に変更しない。

## 設定保存の契約

- 正規IDは`gpt_connector`。その登録へ不足keyだけを追加し、既存command・args・env、モデル、認証、他MCPを保つ。
- TOMLは構文上の位置へkeyを追加し、既存値・コメント・整形を保持する。JSONは既存objectを保って整形する。
- 初回commandはClaude/Codexで`gpt-connector-mcp`、Grok/Cursorでnpm globalの同名実行fileの絶対path。WindowsのGrok/Cursorは公式npmの`.cmd`を使う。既存commandを`node + mcp.js`へ置き換えない。
- 不足時だけglobal binを含む起動用PATH、`GPT_CONNECTOR_CDP_ENDPOINT`を補う。既存envを優先し、明示された`GPT_CONNECTOR_STATE_DIR`も維持する。
- 更新前のfileは`~/.gpt-connector/setup-backups/`へowner-onlyのtarとして保存する。結果JSONにbackup pathを返す。変更がない再実行ではbackupを増やさない。
- 読取後に共有fileが変わっていれば上書きせず失敗する。syntax error、書込み失敗、remote登録との衝突は成功にしない。
- 利用者が無効化したserverは無効のままにし、そのserverを起動しない。`disabled_by_user`と`action_required`を返す。

Codexで不足時に補う公開契約:

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

既存のtimeout、`enabled_tools`、`disabled_tools`、approval設定、env等は利用者設定として優先する。
公式CLIの`add`だけでは指定できない項目も製品のmerge処理で保持する。
設定項目の一次資料は[OpenAI公式MCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## OS・機能別の完了判定

| 機能 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| npm package導入、4AIへの設定保存 | 対応 | 対応 | 対応 |
| stdio initialize、公開版照合、7 tools list | 対応 | 対応 | 対応 |
| `diagnostics`の診断応答、既存state読取り | 対応 | 対応 | 対応 |
| `sessions`の既存job読取り | 対応 | 対応 | 対応 |
| browser起動・表示、models、Chat、画像・添付 | 対応 | 対応 | 未対応 |
| Codex Desktopへの自動Steer | 対応 | 対応 | 未対応 |

setupは各登録のcommand・args・envでMCPへ接続し、応答したversionと7 toolsを確認する。
`diagnostics`が`not_ready`を返す場合も、MCP通信の成立とlive readinessを別に記録する。
`setup`自身は利用者jobの内容を表示しない。

| `overall` | 終了code | 意味 |
| --- | --- | --- |
| `ready` | 0 | 指定した登録、MCP、state、live、Codex登録時のSteerの確認が完了 |
| `action_required` | 1 | 手動ログイン、Codex再起動、または利用者の無効化設定への対応が必要 |
| `failed` | 1 | 導入・登録・MCP・state・browserのいずれかが失敗 |
| `partial` | 2 | Linuxの対応機能は完了、liveブラウザ操作は未対応 |

Linuxの`partial`をpackage導入やMCP登録の未対応へ読み替えず、liveまで成功したとも報告しない。
`registrations`にAI別の保存先、backup、MCP、state、live、失敗段階を返す。秘密値や構文errorの生内容は出力しない。
`SETUP_PACKAGE_FAILED`はnpm導入・引継ぎ、`SETUP_REGISTRATION_FAILED`は設定読取・構文・保存、
`SETUP_MCP_FAILED`はcommand解決・版・stdio応答、`SETUP_STATE_FAILED`はstate読取、
`SETUP_BROWSER_FAILED`はブラウザ準備の失敗を示す。既存の`ConnectorError`ではその公開codeを返す。

各AIは新しいセッションで設定を読む。`clientActivation = new_client_session_required`は既存AIセッションへの反映済みを意味しない。
最終導入確認では対象AI自身から登録・read-only toolを確認する。Codex project設定ではtrusted projectを開く。

## MacとWindowsのブラウザとログイン

専用profileは`~/.gpt-connector/browser-profile`、製品が起動・表示を所有するendpointは`http://127.0.0.1:9223`。
setupは各登録のenvでdoctorを実行し、`ready`なら重複起動しない。`cdp_unavailable`なら既存`startBrowser`を呼び、再診断する。
認証待ちでは既存`showBrowser`、または`startBrowser`自身の認証復帰処理で専用Chromeを表示してから停止する。
人がログインした後、同じsetupを再実行する。

`browser start`はcold startで窓なしChromeのCDP browser endpointからbackground ChatGPT targetを作り、
正規PIDをAppKit `hidden`へ移してからapp readyを待つ。成功条件はhiddenかつWindowServer layer 0の表示window 0件。
`browser show`は正規PIDをunhide／activateし、unhiddenかつ表示window 1件以上を確認する。
CDPの`minimized`はcold target作成時のhintであり、画面非表示状態の正本ではない。

doctor単体の`reasonCode`が`auth_required`なら、
次の正規入口で専用Chromeを表示できる。

```bash
gpt-connector browser show
```

別endpointは既存設定として保持するが、接続できない時に既定9223へ切り替えない。
そのendpointの準備・ログインが必要なことを失敗として示す。
runtime drift、ポート所有衝突、表示確認の失敗を成功にしない。
Chrome更新時のsmokeは`browser start`、`models`、hidden中の最小Chat、必要時の`browser show`で行う。

## 境界と最終報告

通常Chrome、Oracle、他製品のprofileや認証を再利用しない。password、cookie、tokenを要求・取得・表示しない。
本serverが提供するmodelはOpenAI ChatGPTだけ。Claude・Codex・Grok・Cursorは呼出し元AIであり、提供modelのprovider集合を増やすものではない。
最終報告には公開version、正規コマンド、OS/AI/機能別の実測・未実施、設定fileとbackup、
未完了なら失敗段階・reason・次に必要な操作を記す。工場が所有する他MCP、AI本体、host管理を製品へ取り込まない。

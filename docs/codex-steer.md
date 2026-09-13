# Codexへの自動Steer

Codex Desktopから`consult`を呼ぶと、受付結果が返った後もMCPのコードが相談を監視し、完了時に同じ親タスクへ回答を送る。
実行中の親には同じターンへSteerし、終了後の親には同じタスクで新しいターンを開始する。利用AIに監視ループは必要ない。

## 単独導入

前提はNode.js 22以上、macOSまたはWindowsの公式Codex Desktop（同梱CLI 0.154以上）と、通常のChatGPT接続環境。
起動中継・接続・監視・配送は本packageに同梱する。Aitermのインストール、コマンド、設定ファイルは使わない。

```bash
npx --yes gpt-connector@latest setup
```

Codexを登録するMacとWindowsではSteer接続も準備する。再起動が必要なら`codexSteer.status=restart_required`を返す。
Codexを完全終了して再起動し、次で`ready`を確認する。

```bash
gpt-connector setup --check
gpt-connector setup --codex-steer status
```

設定は`~/.gpt-connector/codex-steer/`が所有する。Macのログイン時設定は`~/Library/LaunchAgents/dev.kitepon.gpt-connector-codex-relay.plist`へ置く。
専用launcherをGUIの`CODEX_CLI_PATH`へ設定し、公式署名binaryを変更せずに起動する。
元の起動設定を保存し、候補のinitialize・終了を確認してから設定を有効にする。
Macのsocketは本人所有の0700 directory内に0600で作り、TCP portは開かない。

WindowsではPowerShell 7と標準.NET Frameworkを使い、同じ保存先へ専用の起動exeを作る。
公式Desktopが展開した実行用コピーを、インストール済みMSIXの4実行fileとSHA-256で照合して使う。
Desktopをまだ一度も起動していない場合は、公式Desktopを起動してからsetupを実行する。
ユーザー環境変数`CODEX_CLI_PATH`を設定し、公式CLIへ認証付きのloopback WebSocketで接続する。
外部addressでは待ち受けない。接続ごとの認証情報は製品専用directoryにACLで保護して保存し、終了時に削除する。
起動元→公式Codex→Node中継の直接の親子関係をMacと同じに保つ。Windowsの起動exeは終了監視だけを行い、JSON-RPCを中継しない。
親のPID・生成時刻・実行file・接続引数・MCPの祖先processを照合する。短い要求もEOFを待たず転送する。
初回導入・起動exeの更新後は、Codexを完全終了してスタートメニューから起動する。通常の相談ごとの再起動は不要。

Mac・Windowsとも、既に同じ公式App Serverへ接続できる場合は`connection=existing`で共存し、起動設定を書き換えない。
互換性を確認できない別設定は`codex_steer_configuration_conflict`で止まる。他製品のファイルへは書き込まない。
既存受付がなくなった場合は配送エラーとし、本製品のsetupで再準備する。

```bash
gpt-connector setup --codex-steer enable
gpt-connector setup --codex-steer disable
```

`enable`は通常setupと同じ導入・診断を行う。`disable`は本製品が所有する起動設定だけを復元し、Codexの再起動を求める。
他製品と共有した接続は解除しない。`status`／`disable`単独の終了codeはready・disabledで0、再起動待ちで3、失敗で1。
通常setupの終了codeは[セットアップ契約](ai-installer-setup-contract.md)に従う。

## 受付・監視・配送

宛先は、MCP client名`codex-mcp-client`とCodexが付ける要求metadataの`threadId`、MCPを起動した親processの公式接続から決める。
利用AIへ親IDやsocketの指定を要求しない。同じApp Serverで既に読み込まれた親だけに送り、native sub-agentは対象外とする。
相談送信前に宛先を確認し、未設定・対応外・宛先不明は`PARENT_DELIVERY_UNAVAILABLE`で止める。

`consult`の`wait`指定にかかわらず、受付時にslug・状態と、`keepOpen=true`なら会話用の`sessionId`を返す。
MCPのコードは10秒ごとにpage bridgeの処理状態を読む。完了判定は公式senderの完了と
`finished_successfully`・`endTurn=true`の結果によるもので、AIや画面判定を使わない。通常Chatの待機期限は10分。
生成成功・失敗を台帳へ保存してから親へ通知し、会話の継続には同じ`sessionId`と新しいslugを使う。

公式`turn/start`へ配送ID付き本文を一度だけ渡す。公式受付が実行中か終了後かを同一処理で判定するため、
状態確認と送信の間に親が終了してもキューへ放置しない。モデル・思考量・承認・sandbox設定は変更しない。
追加接続に届く承認要求へは応答せず、Desktopとのstdio中継が通常どおり受け渡す。

snapshotの`delivery`は`id`、`mode=steer`、`state`、`error`を持つ。ChatGPTの成否とは別に保存する。

| 配送状態 | 意味 |
| --- | --- |
| `waiting` | 相談の完了または配送開始を待っている |
| `sending` | 配送開始を保存済みで、公式受付への処理中 |
| `submitted` | 公式受付のターンIDを確認した。親AIの回答完了までは意味しない |
| `failed` | 宛先確認または受付が失敗した |
| `unknown` | 送信後の切断・timeout等で受付有無を確定できない |

再接続で台帳を開くと、未送信の完了結果を配送する。送信中だった記録は`unknown`へ固定して再送しない。
MCP終了前に相談が未完了だった場合は、従来の復旧契約に従い`JOB_RECOVERY_UNAVAILABLE`とする。
配送エラーはstderrと`sessions`へ記録する。回答は台帳に残るため、同じ相談を再実行せず`sessions`で回収する。
MCP processが終了している間の監視は行わない。

自動Steerの対象はCodex Desktopの`consult`。他のクライアント、CLI、互換`chatgpt_chat`、画像生成は従来の応答方式を使う。

## 検証と実装の由来

OS差は環境への適合だけに閉じ込める。製品の判定・処理順序はMacの既存実装を正本とし、全OSで共通にする。

| 共通コードが所有するもの | OS依存コードが所有するもの |
| --- | --- |
| 引数の受付・stdio指定の処理 | shellの引用とexec、CreateProcessWとハンドル継承 |
| JSONLの転送・失敗判定・終了の判断 | Unix socketまたは認証付きloopback、signalまたはWindowsの終了API |
| setupの検証順序・競合・復元・既存接続との共存 | 公式binaryの探索、LaunchAgentまたはユーザー環境変数、modeまたはACL |

`test/codex-relay-arguments.test.ts`は旧Mac launcherの固定標本と引数・拒否条件を比較する。
`test/codex-setup-parity.test.ts`は同じ設定の入力と期待値をMac・Windowsへ適用する。
`test/codex-relay-stdio.test.ts`は本文の往復、承認要求の受渡し、EOF・切断・バイナリ応答を確認する。

`test/codex-parent.test.ts`で宛先の照合、拒否、切断、timeout、承認要求との分離を確認する。
`test/setup-codex-steer.test.ts`で単独導入・解除・既存接続との共存を確認する。
公式binaryを持つMac・Windowsでは、build後に次の試験で実行中のSteer、終了後の受信、承認中継、終了処理を確認できる。
一時HOMEとローカルの模擬Responsesを使い、実利用者の認証や外部モデルは使わない。

```bash
GPT_CONNECTOR_TEST_CODEX_BINARY=/absolute/Codex.app/Contents/Resources/codex npm run test:codex-steer
```

Windowsでは`test/windows-codex.test.ts`が引数保持、EOF前の転送、公式CLIのinitialize、
認証付きの追加接続、EOF後のprocess終了と接続情報削除を確認する。公式CLIを使う試験はbuild後に実行する。

```powershell
$env:GPT_CONNECTOR_TEST_CODEX_BINARY = 'C:\path\to\codex.exe'
pnpm exec tsx --test test/windows-codex.test.ts
```

MSIXの仮想AppDataからの起動は、`GPT_CONNECTOR_TEST_CODEX_PACKAGE`と同梱CLIを指定して `node --test scripts/codex-steer-msix.test.mjs` で確認する。

Windowsの接続仕様は[公式App Server](https://learn.chatgpt.com/docs/app-server)とWindows同梱CLIで確認する。

launcher・stdio中継・setupと公式binary試験は、[Aiterm](https://github.com/kitepon/aiterm-mcp)のMIT実装を参考に移植した。
移植元のCopyright (c) 2026 kiteponとMIT許諾は本packageの[LICENSE](../LICENSE)にも含まれる。
移植後のコードと試験はgpt-connectorが所有し、Aitermの更新やインストールを実行条件にしない。

# Codexへの自動Steer

Codex Desktopから`consult`を呼ぶと、受付後もMCPが相談を監視し、完了時に同じ親タスクへ回答を送る。
実行中は公式の同期hookから同じターンへ取り込み、終了後は公式キューから同じタスクを再開する。利用AIの監視ループは不要。

## 単独導入

Node.js 22以上、macOSまたはWindowsの公式Codex Desktop（同梱CLI 0.154以上）、通常のChatGPT接続環境を使う。
WindowsのシェルはPowerShell 7。配送・hook・導入コードは本packageに同梱し、Aitermのインストール・コマンド・設定は使わない。

```bash
npx --yes gpt-connector@latest setup
```

setupは`CODEX_HOME`（省略時は`~/.codex`）の`hooks.json`へ`PostToolUse`と`Stop`を登録する。
公式`hooks/list`で自分の登録を照合し、`config/batchWrite`でその2件の現在のhashだけを承認して読戻す。
他のhook、承認、モデル、認証、sandbox設定を保持し、承認の一括迂回は使わない。
HomebrewのNodeは版別Cellar pathを永続登録せず、同じformulaの`opt`入口を使う。

Codexの実行file・起動設定は差し替えない。旧版の中継がある場合だけ、新hookの承認と読戻しを終えた後で
本製品の`CODEX_CLI_PATH`とMacのログイン時登録を解除する。他製品が変更した起動設定は上書きしない。
導入前から動くCodexはPIDと生成時刻で識別し、`codexSteer.status=restart_required`を返す。
Codexを完全終了して再起動し、次で`ready`を確認する。

```bash
gpt-connector setup --check
gpt-connector setup --codex-steer status
```

本製品の設定・配送所有記録・hook出力記録は`~/.gpt-connector/codex-parent-hooks/`が所有する。
回答を含む記録はPOSIXの0700 directory／0600 file、Windowsの本人専用ACLで保護する。
Codexの領域へはhook登録と公式APIによる承認だけを置く。旧`codex-steer/`は移行情報として保持する。
Windowsは公式Desktopが展開した実行用コピーをMSIXの実行fileとSHA-256で照合する。
Desktop未起動で実体がない場合は、公式Desktopを一度起動してからsetupする。

```bash
gpt-connector setup --codex-steer enable
gpt-connector setup --codex-steer disable
```

`enable`は導入・承認・診断を行い、`disable`は自分のhookだけを除去する。Nodeの旧pathが消えていても解除できる。
`status`／`disable`単独の終了codeはready・disabledで0、再起動待ちで3、失敗で1。
通常setupの終了codeは[セットアップ契約](ai-installer-setup-contract.md)に従う。

## 受付・監視・配送

宛先はMCP client名`codex-mcp-client`、Codexが付ける要求metadataの`threadId`、MCPの`CODEX_HOME`から決める。
利用AIへ親IDや接続先の指定を要求しない。独立した公式App Serverを通常stdioで起動し、同じCodex環境の公式キューへ接続する。
相談送信前に親タスク、queue API、自分のhookの有効化・承認、導入後の起動を確認する。native sub-agentは対象外。
配送できない場合は`PARENT_DELIVERY_UNAVAILABLE`で止め、ChatGPTへ相談を送らない。

`consult`の`wait`指定にかかわらず、受付時にslug・状態と、`keepOpen=true`なら会話用の`sessionId`を返す。
MCPは10秒ごとにpage bridgeの状態を読み、公式senderの完了と`finished_successfully`・`endTurn=true`で判定する。
通常Chatの回答待ちに時間制限は設けず、生成の成功・明示的な失敗・通信エラーまで待つ。
接続やuploadなど個別操作の期限は維持する。結果を台帳へ保存してから親へ通知する。

`thread/queue/add`へ配送ID付き本文を一度だけ渡す。同期hookは配送ID・親タスク・本文hashを本製品の所有記録と照合し、
一つのhookだけがclaimを取得して`thread/queue/delete`を行う。`PostToolUse`は`additionalContext`、
`Stop`は`decision:block`と`reason`で本文を出力する。利用者や他製品の入力は取り出さない。
hook通過後やターン終了後に届いた回答は、通常の公式キューが処理する。

snapshotの`delivery`は`id`、`mode=steer`、`state`、`error`を持ち、ChatGPTの成否とは別に記録する。

| 配送状態 | 意味 |
| --- | --- |
| `waiting` | 相談完了または配送開始待ち |
| `sending` | 公式キューへの投入中、またはhookが取り出し中 |
| `submitted` | 公式キュー受付済み。親AIの回答完了を意味しない |
| `failed` | 宛先確認または受付が失敗した |
| `unknown` | 送信後の切断・timeout・hook出力失敗等で到達を確定できない |

hookによる取り出しが中断した場合も`sessions`は`unknown`を返す。本文は保存し、自動再送しない。
再接続では未送信の完了結果だけを配送する。送信中だった記録は`unknown`とし、MCP終了時に相談が未完了なら
`JOB_RECOVERY_UNAVAILABLE`とする。MCP停止中の監視は行わない。保存済み回答は`sessions`で回収する。

台帳version 4はversion 1・2・3を読める。読取りでは変更せず、初回書込み前に元fileを`.v<元version>-backup`へ保存する。
旧版で受付済みのsocket宛先は旧配送契約のまま保持し、新規相談は公式キューを使う。新方式から旧中継への自動切替は行わない。
旧版へ戻す場合は[CHANGELOG](../CHANGELOG.md)の巻き戻し条件に従う。

自動配送の対象はCodexの要求metadataを持つ`consult`。他クライアント、互換`chatgpt_chat`、画像生成は従来の応答方式を使う。

## 検証と由来

Aitermで実証した公式キューと同期hookの方式を、gpt-connectorの所有コード・状態・setupへ移植した。
配送・承認・移行の制御はMacとWindowsで共通。プロセス識別、公式binary探索、シェル引用、権限だけをOS適合へ分離する。

```bash
pnpm build
pnpm test:codex-hooks
GPT_CONNECTOR_TEST_CODEX_BINARY=/absolute/path/to/official/codex pnpm test:codex-steer
```

公式fixtureは隔離したHOMEとローカル模擬モデルを使い、実credentialを使わない。
同一ターン、Stop、終了後、hook消失、終了境界、利用者入力、未承認の他hookとの共存を検証する。
公開仕様は[Codex公式hook仕様](https://learn.chatgpt.com/docs/hooks)を参照。

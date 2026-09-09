# setup導入の検証状況

2026-09-10時点。**実装と3OSの公開前gateは完了、npm公開は権限確認待ち。公開版の実機導入は未完了。**

対象commitは[`30971db`](https://github.com/kitepon/gpt-connector/commit/30971db5327b505b741e64a0603dc3f7499c50d1)、候補tagは`v0.5.2`。
この時点のnpm公開版は0.4.18であり、0.5.2を導入済みと扱わない。

## 検証結果

| 対象 | 結果 | 根拠・限界 |
| --- | --- | --- |
| 初回・再実行・既存設定移行 | 成功 | 4AI、env・認証・モデル・他MCP・Codex timeout/tool制限の保持試験 |
| 配布packageのMCP・state | 成功 | Macの隔離npm prefixで4AI initialize・7 tools・diagnostics・state読取り。再実行unchanged。SSH導入の代替には数えない |
| Mac CI | 成功・14秒 | 現役macos-native runnerの製品試験 |
| Linux CI | 成功・18秒 | 現役linux-workstation runnerの製品試験 |
| Windows CI | 成功・24秒 | Windows native、実ACLを含む製品試験 |
| release commit・pack gate | 成功 | main祖先、clean worktree、配布物・文書参照の検査 |
| npm公開 | 失敗 | provenance署名後、registryのPUTがE404で拒否 |
| npm公開設定の確認 | ログイン待ち | 公式CLIのtrust listはE401、WebはSign Inへ遷移。設定不一致はまだ確定していない |

詳細は[公開CI](https://github.com/kitepon/gpt-connector/actions/runs/34374479045)、[反証と受入判断](adr/2026-09-10-product-setup.md)を参照。

## OS・AI・機能別の実機確認

| 実機 | Claude / Codex / Grok / Cursor登録・MCP | 公開版のstate・sessions | liveブラウザ |
| --- | --- | --- | --- |
| Mac | 公開版のSSH試験は未実施 | 未実施 | 対応機能だが未実施。SSH接続先が未確定 |
| Linux（main-server） | 公開待ちで未実施 | 未実施 | 製品として未対応 |
| Windows（windows-workstation） | 公開待ちで未実施 | 未実施 | 製品として未対応 |

LinuxとWindowsのAiterm永続PTYによるSSH接続は確認した。WindowsではPowerShell 7を使用し、sourceの配布物検査を単独実行して成功した。
LinuxではClaude・Codex・Grokを確認できたがCursor CLIは見つからず、WindowsではCodex CLIを確認できていない。
AI設定への4AI登録・MCP protocol確認と、AI本体からの確認は分けて記録する。
既存fox-wslへのSSHは2回timeout。WSL専用CI runnerは工場正典で退役済みであり、製品のLinux read-only機能の削除とは別の事実である。

共有AI設定は今回まだ変更していない。npm公開後、他製品の導入と重ならないことを確認して反映する。

## 公開後の正規コマンド

公開前の現在は、新しいsetupが使える公開版として以下を実行しない。

```sh
# 初回・更新
npx --yes gpt-connector@latest setup
# 導入済み版での再実行
gpt-connector setup
# 読取り専用診断
gpt-connector setup --check
```

## 工場から移せる設定代行

公開版への移行と実機受入後は、工場にあるgpt_connectorのnpm導入・4AI登録生成・既定env/PATH追加を製品setup呼出しへ置き換えられる。
対象はsetup-macos-factory.sh、setup-linux-common.sh、setup-windows-native-factory.ps1、apply-grok-config.sh、apply-cursor-config.sh内の本製品の登録処理。
AI本体、他MCP、host、runner、工場横断のdiagnosticsは工場が引き続き所有する。今回dotagentsは変更していない。

## 再開条件

1. npm package所有者としてログイン・2FAを完了し、gpt-connectorのTrusted Publisherを確認する。期待値はGitHub `kitepon/gpt-connector`、workflow `ci.yml`、publish許可。現在の値は未確認。
2. 公開設定が成立した後、同じCIの失敗したpublish jobを再実行する。既存tagとversionは変更しない。
3. npm registryとGitHub Releaseを確認し、Aiterm SSHセッションで公開npm版のsetup・再実行・AI別MCP/state/sessionsを実測する。
4. MacのSSH接続先を確定し、Macの公開版とlive readinessを確認する。認証が必要なら専用Chromeで人がログインする。

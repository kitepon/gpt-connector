# setup導入の検証状況

2026-09-10時点。**0.5.2のnpm公開とLinux・Windowsの実機導入は完了。MacのSSH導入確認は接続先待ち。**

公開commitは[`30971db`](https://github.com/kitepon/gpt-connector/commit/30971db5327b505b741e64a0603dc3f7499c50d1)。
[GitHub Release](https://github.com/kitepon/gpt-connector/releases/tag/v0.5.2)とnpm registryで0.5.2を確認した。
[公開CI](https://github.com/kitepon/gpt-connector/actions/runs/34374479045)は成功し、
[provenance](https://registry.npmjs.org/-/npm/v1/attestations/gpt-connector@0.5.2)が付いている。

## 検証結果

| 対象 | 結果 | 根拠・限界 |
| --- | --- | --- |
| 初回・再実行・既存設定移行 | 成功 | 4AI、env・認証・モデル・他MCP・Codex timeout/tool制限の保持試験 |
| Mac CI | 成功・14秒 | 現役macos-native runnerの製品試験 |
| Linux CI | 成功・18秒 | 現役linux-workstation runnerの製品試験 |
| Windows CI | 成功・24秒 | Windows native、実ACLを含む製品試験 |
| release commit・pack gate | 成功 | main祖先、clean worktree、配布物・文書参照の検査 |
| npm公開 | 成功 | GitHub Actionsから0.5.2を公開、registryとprovenanceを確認 |
| Linux公開版導入 | 成功 | Aiterm SSH内のnpm公式入口でglobal導入、4AI登録とMCP診断 |
| Windows公開版導入 | 成功 | Aiterm SSH内のPowerShell 7で同じ入口、4AI登録とMCP診断 |
| Mac公開版SSH導入 | 未実施 | localhost:22の接続が成立せず、接続先待ち |

初回の公開失敗はnpmのTrusted Publisher未登録によるものだった。
所有者のログイン後に未登録を確認し、承認を受けてnpm公式CLIから
GitHub `kitepon/gpt-connector`・workflow `ci.yml`・publish許可の接続を登録した。
失敗した公開処理の再実行で成功した。公開直後のLinuxではバージョン一覧の反映待ちとなり、
npmの`--prefer-online`で0.5.2の取得を確認してから導入した。

## OS・AI・機能別の実機確認

| 実機 | 4AI登録・MCP | 設定保持・再実行 | state・sessions | liveブラウザ |
| --- | --- | --- | --- | --- |
| Mac | 公開版SSH試験は未実施 | 未実施 | 未実施 | 対応機能だが未実施 |
| Linux（main-server） | 全4AIでinitialize・7 tools・diagnostics成功 | 全4設定の既存値保持、再実行unchanged | CLI/MCP読取り成功、state不変 | 製品として未対応 |
| Windows（windows-workstation） | 全4AIでinitialize・7 tools・diagnostics成功 | 全4設定の既存値保持、再実行unchanged | CLI/MCP読取り成功、state不変 | 製品として未対応 |

LinuxとWindowsでは、公開版の初回入口、導入済み版の再実行、`setup --check`を同じSSHセッションで実行した。
既存の共有AI設定を使用し、変更前の設定は製品のsetup-backupsへ保存された。
導入前に他製品の設定変更処理が動いていないことを観測した。
非Macの終了値2・overall `partial`はlive未対応の明示であり、登録・MCP・stateは全件readyだった。

sessionsは製品所有directory内に終端状態のfixtureを作り、公開版CLIとMCPで読んだ。
読取り前後のstateファイルのhashは一致した。Chat送信は行っていない。
Windowsの初回記録はPowerShellの出力変換で日本語が文字化けしたため、
記録をNodeからUTF-8で直接保存して再確認した。初回の4AI登録とbackup作成も元の記録で確認した。

### AI本体からの認識

| 実機 | Claude | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| Linux | `mcp get`でConnected | `mcp get --json`で登録・enabledを確認 | `mcp doctor`でhealthy・7 tools | CLIが見つからず未実施 |
| Windows | `mcp get`でConnected | CLIが見つからず未実施 | `mcp doctor`でhealthy・7 tools | CLIが見つからず未実施 |
| Mac | 公開版SSH試験は未実施 | 未実施 | 未実施 | 未実施 |

4AIそれぞれの設定を使うMCP接続試験と、AI本体の認識確認は別の検証である。
Codexの`mcp get`は設定認識の確認であり、AIによるtool実行の証拠には数えない。
Windowsの`agent.exe`はGrok配下であり、Cursor CLIとは扱っていない。
不足するAI本体の導入は本製品の担当範囲へ追加していない。

既存fox-wslへのSSHは2回timeout。WSL専用CI runnerは工場正典で退役済みであり、
製品のLinux read-only機能の削除とは別の事実である。
Macの隔離npm prefixで成功した4AI試験は、SSHによる公開版導入の代替には数えない。

## 正規コマンド

```sh
# 初回・更新
npx --yes gpt-connector@latest setup
# 導入済み版での再実行
gpt-connector setup
# 読取り専用診断
gpt-connector setup --check
```

## 工場から移せる設定代行

Linux・Windowsでは、本製品のnpm導入・4AI登録生成・既定env/PATH追加を製品setupへ移せることを実機で確認した。
Macの移行判断には公開版のSSH受入が残る。
対象はsetup-macos-factory.sh、setup-linux-common.sh、setup-windows-native-factory.ps1、
apply-grok-config.sh、apply-cursor-config.sh内のgpt_connector登録処理。
AI本体、他MCP、host、runner、工場横断のdiagnosticsは工場が引き続き所有する。
今回dotagentsと他製品repoは変更していない。

## 残る受入

MacのSSH接続先を確定し、Aiterm永続PTYから公開版のsetup・再実行・4AI MCP/state/sessionsとlive readinessを確認する。
ChatGPTの認証が必要なら、製品の正規入口が表示する専用Chromeで人がログインする。
この観測が済むまでcampaign全体は完了としない。

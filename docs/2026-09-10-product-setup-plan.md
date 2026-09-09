# 製品所有の導入入口

## 目的と範囲

一回の製品入口でnpm導入、ブラウザ準備、診断、Claude・Codex・Grok・Cursor登録を完結する。変更は本repoと製品の導入先だけ。dotagentsの既存配線は読取り専用とする。Macのlive機能と全OSのMCP・state読取りを区別し、既存env・認証・モデル・他MCP・利用者の制限設定を保つ。

## 工程と受入

1. fetch、dirty・stash・正典・工場配線確認、既存focused試験。
2. setupとAI別設定アダプタ、初回・再実行・移行・失敗のfocused試験。
3. 全Markdown点検と必要な更新、別ベンダーによる境界・設定保存の反証。
4. 製品release gate、main統合、push、tag CIでnpm公開、GitHub Release。
5. Aiterm永続PTYのSSHセッションで公開npm版を公式導入し、同じセッションでsetupとOS・AI別smoke。共有AI設定は端末ごとに直列で変更する。

ログインが必要なら専用Chromeを表示し、人のログイン後に同じ入口を再実行する。失敗・未対応・未検証は成功と別の状態で返す。通し試験はfocused試験完了後の最終gateだけに使う。

## 裁定

受入が公開・実機導入へ連なり、境界変更の証跡も必要なため統括レーンとする。Fは境界・設定保存・公開・実機受入、Aは実装、Hは人のログインだけ。実装と設定形式が密結合するためwriterは親一人とし、別ベンダー反証だけを独立して依頼する。Lattice工程管理は適用しない。

## 既知の罠と非目標

- 非Macのoverall未対応をpackage・MCP未対応と解釈しない。
- Codexのaddだけでtimeoutやenabled_toolsを落とさない。
- browser start/showの所有検査・可視性確認を再実装しない。
- 他製品repoの改修、daemon追加、認証情報の取得、setupのためのChat送信はしない。

## 現在地

fetch済みmainはorigin/mainと一致、dirty・stashなし。既存focused試験44件成功。工場の4AI登録を実ファイルで確認済み。

2026-09-10: setup実装と設定保存のfocused試験が完了。関連33件、製品試験166件成功／1件skip、release gate 5件成功。
隔離npm prefixへpackを公式installし、4AIの初回登録・再実行・checkでMCP initialize、7 tools、diagnostics、state読取りが成功。
再実行は全設定unchanged。到達しない独自CDP endpointを指定した試験ではbrowser失敗を明示し、既定browserを起動しなかった。
MacへのSSH接続先は未確定（localhost:22接続拒否）、fox-wslは既存接続先へ2回timeout。LinuxとWindowsのSSH／PowerShell 7は接続済み。
公開・公開版の実機導入は未完了。

## 反証と修正

- Grokによる境界反証: `node + mcp.js`への登録置換は既存工場のcommand照合から外れ、工場の再適用でenv等が失われ得る。採用し、既存command/argsを保持、新規も工場と同名commandへ修正。
- 同反証: 従来のCodex project設定をhomeだけの登録では引き継げない。採用し、既存fileを明示する`--codex-config`を追加。
- 配布物実測: npm prefixとNodeの場所が別の時、起動PATH不足で`env: node: No such file or directory`。新規PATHへ実行Nodeのdirectoryを追加し、同条件で4AIのMCP成功を確認。
- release試験: npm 12のpack JSON object形式と、親のdry-run継承によるtarball未生成を確認。検査は配列/object双方を受け、内側packは実生成を明示する。

## 文書点検

追跡対象Markdown全47件を目録で確認。現行6件（README、CHANGELOG、docsの地図・installer・attachment・release）を設定入口と突合し、必要箇所を更新した。
archive 13件とrag 26件は当時の証拠、fixture 2件は試験入力として保持する。現行案内は文書地図の6件へ限定する。
packageに同梱するMarkdownは既存の目録・link検査で、参照先まで配布物に含まれることを確認する。

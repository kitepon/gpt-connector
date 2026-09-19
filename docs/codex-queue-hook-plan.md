# Codex親配送の単体導入修理

目的: gpt-connectorだけを導入したMac／Windowsで、Codexの起動を差し替えず、公式キューと同期hookによる同一ターン配送・終了後再開を提供する。

## 範囲と判断

- F: 宛先の束縛、キュー本文の所有確認、取り出しと配送状態、hook承認、旧中継解除、公開と導入を親が担当する。
- 実装は同じ配送・設定契約に結合するため親が直列に行う。移行・台帳互換・共存条件の読み取り専用反証だけを独立に行う。
- Aitermの実証済み方式を移植するが、依存package・設定・状態・installerは共有しない。
- 既存のChatGPT接続、回答期限撤去、model選択、7つのMCP tool、Mac／Windows対応を維持する。
- 旧版の保存済み結果は読める状態を維持する。配送不明は本文を保持し、自動再送しない。
- 対象外: Chrome接続方式の変更、他製品の設定修理、Windows/Linuxの新機能。

## 原因と既知の条件

- 0.9.2もNode製中継をCodexの起動へ挿入し、親processのsocketを必須とする。Node更新・中継消失・他製品の起動変更がCodex起動と配送へ波及する。
- Homebrewの版別Cellar pathを永続登録へ保存しない。
- 公式hookは同時実行されるため、キュー取り出しはgpt-connector所有記録との照合と単一claimを必要とする。
- hook承認と読戻しを先に終え、自製品が所有する旧中継だけを解除する。他製品のGUI値・hook・承認は変更しない。
- AIShellのworkspace検査はXcodeライセンス未同意で失敗する。Aitermの通常PATHにあるHomebrew Gitで状態確認し、変更は標準patchで行う。

## 受入

1. 同期済みmainで関連試験を確認し、旧方式の再現を固定する。
2. 単体setup、承認、移行、複数hook、他製品入力保持、出力失敗、旧台帳のfocused testを通す。
3. 公式Codexと模擬モデルによる同一ターン・Stop・終了後・hook消失・他hook共存を確認する。
4. 独立反証、lint・型・全試験・配布検査を完了し、mainへpushする。
5. 3OS製品CI、npm provenance、GitHub Release、公式導入、公開packageのMCP・配送smokeを完了する。

## 現在地

- 同期後0.9.2の関連試験15件成功。通常stdioで親socket必須の失敗を再現し、公式queue/hookへ修理した。
- 新配送・移行の個別試験、公式Codexの7条件が成功。独立レビューの旧Windows binary見落とし・home消失時の状態丸めをfocused testで修正済み。
- lint・typecheck・全230試験（成功223、他OS等のskip7）成功。3OS CI・公開・導入・公開後smokeへ進む。
- 0.9.3をmain祖先・3OS CI・provenance付きで公開し、Mac／Windowsへ導入した。両端末でMCP登録・7 toolsを確認。Windowsはhook ready、現在のMac Codexは導入前起動のため完全再起動が必要。
- 公開後setupでChatGPT Webの標準clientと録音adapterの重複を再現した。通信前の経路照合で修理し、focused test、実ブラウザのdiagnostics・models・最小Chatに成功。0.9.4へ含める。
- Windowsの公式配送7条件が成功。試験fixtureのPATHEXT継承・stdio閉鎖待ち・公式dynamic toolを修正し、OSのsandbox設定に依存せず実行する。

## 公開・導入の実測（2026-09-19）

- 0.9.4の公開commitは`a9c9225971f88bab42bda838201dded924d45bd7`。main祖先確認済み。
  [main CI](https://github.com/kitepon/gpt-connector/actions/runs/35443155342)と
  [tag CI](https://github.com/kitepon/gpt-connector/actions/runs/35443231448)のMac・Windows・Linux gateが成功した。
- [npm](https://www.npmjs.com/package/gpt-connector/v/0.9.4)のversionとSLSA provenanceを確認し、
  [GitHub Release](https://github.com/kitepon/gpt-connector/releases/tag/v0.9.4)を公開した。
  provenance transparency log indexは`2892484234`。
- lint・型検査、全231試験（成功224、対象OS以外等のskip7）、配送・移行20試験、release gate5試験が成功。
  公式Codexの通常stdioと隔離HOMEを使う7条件はMac・Windowsとも成功。fixtureはAitermに依存しない。
- Mac: 公開packageのglobal installと`npx --yes gpt-connector@0.9.4 setup`を実行した。
  4AI登録・state・MCP 7 tools・liveはready。導入前から動くCodexだけ`restart_required`で、setup/checkは終了1・`action_required`。
  modelsとInstantの最小Chat・archive読戻しに成功した。最初の公開版Chatは`CHAT_FAILED: Something went wrong.`を返し、独立した再試行は成功した。原因未特定のため製品コードへ再試行や例外処理を追加していない。
- Windows: 同じ公開入口から導入し、setup/checkは終了0・ready。4AI登録・state・MCP 7 tools・live・Codex hookがready。
  Instantの最小Chat・archive読戻しも成功した。SSHのPowerShell出力読取りはUTF-8を明示して測定した。
- Linux: SSHの一時的な接続拒否が解消後、公開packageをglobal installしてsetup/checkを実行した。
  4AI登録・state・MCP 7 toolsはready。live未対応の契約どおり終了2・partialで、live試験は行わない。
- 設定の事前tar backupを3端末で保存。Mac・Windowsの既存モデル・認証・env・他MCP・他hookを保持し、checkによる設定変更がないことを確認した。

## 残る受入と再開

Macの利用中Codexを完全終了して起動し直す操作だけが未実施。現在のタスクを中断するため、自動では終了しない。
再起動後、公開入口`gpt-connector setup --check`でCodex hookのreadyを確認し、このタスクから実相談を1件送って回答の自動配送を確認する。
この観測まではintegrationを完了とせず、Controlをactiveのまま保持する。完了後に本計画をarchiveし、knowledge returnと完了記録を閉じる。

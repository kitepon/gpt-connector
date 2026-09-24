# 製品所有のsetup入口

このADRは2026-09-10の判断を保存する。現在の対応OSと手順は[セットアップ契約](../ai-installer-setup-contract.md)を参照。

状態: 公開版0.5.2と3OSの実機受入を完了。詳細は公開後の最終受入に記録した。

## 判断

導入とgpt_connector登録の所有者をgpt-connectorへ集約する。工場は製品のsetupを呼べるが、製品内部の登録生成を代行する必要はない。
入口は既存CLIのsetupだけとし、npm公式導入後に同じ版のCLIへ引き継ぐ。ブラウザ準備は既存startBrowser/showBrowserを再利用する。
4AIを既定対象とし、既存設定への追加だけで移行する。非MacでもMCPとstate読取りを実行し、live未対応をpartialとして別記する。

## 別ベンダー反証

2026-09-10、Grokが製品コード・設定保存試験・工場配線を読取り専用で反証した。
初回はcommandをnodeへ変更すると工場の再適用が設定を置換する点と、Codex project設定をhome登録だけでは移行できない点を指摘した。
既存command/args保持、工場と同名の新規command、既存project設定の明示指定を採用した。
修正後の最終反証は「契約を破る再現可能な重大欠陥なし」。既存env/model/oauth/他MCP/disabled保持、4AI、非MacのMCP/state、npmからの引継ぎを確認した。
Windowsのcmd起動についてはSDKのcross-spawnを確認しただけで、実機試験の代替には数えない。

## 親による受入根拠

関連33件の試験、製品166件成功／Windows限定1件skip、release gate 5件成功。
配布packageの隔離prefix導入では4AIで7 toolsと診断応答、state読取りが成功し、再実行はunchanged。
npm prefixとNode配置が異なる条件でPATH不足を再現・修正し、同条件のpack導入で成功を確認した。
pack内Markdownの参照検査はnpm 12のJSON形式とdry-run継承を修正して通過した。

公開前のコード受入を可とする。SSH先の公開npm版導入、AI本体からの確認、Mac liveは未実施の段階では成功へ含めない。

## 公開後の最終受入

2026-09-10、公開版0.5.2をMacのローカルAiterm永続PTYとLinux・WindowsのSSHで確認した。Macをローカルで確認することはオーナーが明示した。
全3OSの4AI登録、既存設定保持、再実行、MCP/state/sessionsが成立し、Macのlive readinessもreadyだった。詳細とAI本体未導入による未実施は[検証表](../2026-09-10-setup-verification.md)へ記録した。
公開commit・3OS CI・provenance・実機結果を突合し、製品所有setupの最終受入を可とする。工場や別製品への書込みは行っていない。

# gpt-connector 文書地図

このrepositoryはgpt-connectorのinstall、設定、browser、session、state、schema／migration、
diagnostics、recovery、update、releaseを所有する。dotagentsは任意の工場統合を担うだけで、
本製品の実行・運用・復旧に必須ではない。

## 現行文書

- [README](../README.md): 人間向けの導入、browser運用、CLI／MCP、session、diagnostics、更新と復旧。
- [AI installer向けセットアップ契約](ai-installer-setup-contract.md): `setup`による初回・更新・再実行、4AI登録、OS別機能、手動ログインと停止条件。
- [native attachment契約](native-attachment-contract.md): 添付、job、state、recoveryの公開契約。
- [release](release.md): version同期、検証、main着地、npm／GitHub公開、公開後smoke。
- [CHANGELOG](../CHANGELOG.md): 版別変更履歴。

## 文書の寿命

- 現行の製品契約と運用手順だけをこの階層に置く。
- 完了・中止・置換・凍結により現行判断から外れた計画、監査、release receipt、時点証拠は[`archive/`](https://github.com/kitepon/gpt-connector/tree/main/docs/archive)へ移す。
- 同じ目的の現行文書を増やさず、上の正本へ統合する。
- archiveは履歴証拠であり、現在の操作判断には使わない。
- 工場全体のwire、host配置、製品間compatibilityはdotagentsに置き、製品内部の手順を複製しない。

## 履歴

完了・中止・置換・凍結済みの実装計画と公開工程は[`archive/`](https://github.com/kitepon/gpt-connector/tree/main/docs/archive)に保存する。未完了checkboxが残る文書も現行backlogではない。過去のowner名、version、
外部契約は当時の証拠として読み、現行値へ読み替えない。

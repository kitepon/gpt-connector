# gpt-connector 文書地図

このrepositoryはgpt-connectorのinstall、設定、browser、session、state、schema／migration、
diagnostics、recovery、update、releaseを所有する。dotagentsは任意の工場統合を担うだけで、
本製品の実行・運用・復旧に必須ではない。

## 現行文書

- [README](../README.md): 人間向けの導入、browser運用、ChatGPT／GrokのCLI・MCP、並行相談、session、diagnostics、更新と復旧。
- [AI installer向けセットアップ契約](ai-installer-setup-contract.md): `setup`による初回・更新・再実行、4AI登録、OS別機能、手動ログインと停止条件。
- [native attachment契約](native-attachment-contract.md): ChatGPTの添付、job、並行実行時のstate、recoveryの公開契約。Grok Chatのmodeと回答項目は[READMEのGrok節](../README.md#source-setup)と[実測記録](https://github.com/kitepon/gpt-connector/blob/main/rag/grok/observations.md)を参照。
- [Codexへの自動Steer](codex-steer.md): 単独導入、親への配送、既存接続との共存、確認・解除。
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
既存の参照pathを保つために残した[setup計画](https://github.com/kitepon/gpt-connector/blob/main/docs/2026-09-10-product-setup-plan.md)、[setup検証記録](https://github.com/kitepon/gpt-connector/blob/main/docs/2026-09-10-setup-verification.md)、[Codex親配送の案内](https://github.com/kitepon/gpt-connector/blob/main/docs/codex-queue-hook-plan.md)も時点記録として扱う。`adr/`の判断記録は当時の根拠を保存し、現行の操作は上記の契約文書に従う。

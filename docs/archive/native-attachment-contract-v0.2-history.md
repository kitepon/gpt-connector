# Native attachment契約 v0.2 成立履歴

作成日: 2026-07-13

状態: `gpt-connector@0.2.0`公開時の移行・設計履歴。現在の操作判断には使わない。

## 成立時の目的

ローカルworkspaceのfileをChatGPT通常Chatへ正規attachmentとして送り、caller timeout後も
同じ相談を再送せず回収できる契約を、dotagentsのOracle置換に先立って固定した。

当時の公開範囲には本文展開、OpenAI API、Oracleへのfallback、server ID公開を含めなかった。

## 当時の移行互換

- `chatgpt_chat`／`sessionId`を既存利用向けに残した。
- dotagents移行面も同じcoreの`consult`／`sessions`を使い、別adapter packageを作らなかった。
- MCP server IDを`oracle`のままにする移行案はあったが、実装しなかった。
- Oracle固有`engine`を受ける互換面は実装しなかった。`consult`は最初からstrict schemaを使い、`engine`を未知fieldとして拒否した。

## 初版の判断

- file pathをabsoluteのまま受けず、absolute `workspaceRoot`とrelative specに固定した。MCP cwdとhost差異を吸収し、誤送信範囲を限定するためである。
- server hard limitと同値にせず、20 MiB/file、64 MiB totalから開始した。初回runtime transfer／memory matrixが無かったためである。
- 未知binaryはlocalで拒否せず、`application/octet-stream`で公式runtimeへ渡して成否を明示した。
- 各形式をlocal parserで検査せず、元bytesを標準MIMEまたはoctet-streamで渡した。
- timeout時の同slug再送を拒否し、同じslugをsnapshot lookupに固定した。
- conversation archiveをfile cleanupとみなさず、retention unknownを公開した。
- sensitive file denylistにoverrideを設けなかった。

より詳しい実装・移行工程は
[`2026-07-13-native-attachment-oracle-replacement-plan.md`](2026-07-13-native-attachment-oracle-replacement-plan.md)と
[`2026-07-13-oracle-replacement-evaluation-plan.md`](2026-07-13-oracle-replacement-evaluation-plan.md)に保存する。

# gpt-connector 0.4.18 tool discovery metadata修理

## 目的

gpt-connectorが呼べない他providerの固有名を否定文としてMCP discovery textへ列挙し、Fable等のtool検索で誤候補になる欠陥を修理して公開する。

## 原因

検索索引は肯定・否定を区別しない。server instructionsへ他provider名を列挙すると、その文字列が全tool説明へ付加され、対象能力が無いのに検索一致する。利用側で候補を捨てる対処は製品修理に数えない。

## 変更契約

- server instructionsと各tool／field descriptionはChatGPTの肯定能力だけを書く。
- 実行可能model／effortは`chatgpt_models`のcatalogだけを正とする。
- discovery textへ他providerの固有名を置かない。
- 実行時catalog検証、tool名、schema、provider境界は変えない。

## Gate

1. discovery textの禁止語試験。
2. `pnpm check`、`pnpm build`、release gate、pack内容確認。
3. release commitをmainへpushし、CI green後にnpm 0.4.18を公開する。
4. npm公開版をglobal installし、MCP tools/listの7 tool説明に禁止語0件、Fable検索でgpt-connector候補0件を確認する。
5. CLI version、doctor、専用Chromeを使わないread-only MCP initializeでstderr 0を確認する。

## Rollback

npm versionは上書きしない。公開後の欠陥は0.4.18をdeprecateし次patchで修理する。global installは直前の0.4.17へ戻せる。


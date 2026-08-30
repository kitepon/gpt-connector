# 正規添付の全file type pass-through計画

作成日: 2026-07-13

状態: 完了

## 目的

`gpt-connector`をfile内容のvalidatorではなくattachment transportとして扱い、workspace内のregular fileを元bytesのままChatGPT公式runtimeへ渡す。既知拡張子には標準MIMEを付け、未知拡張子には`application/octet-stream`を付ける。

## 公式根拠

- OpenAI Help Centerは、text、spreadsheet、presentation、documentの一般的な拡張子を対応対象とし、XLSX、XLS、CSV、TSV、DOCX、PPTX、PDF、TXTを例示する。
- image uploadには20MB/imageの公式上限がある。既存調査でPNG、公式vision資料でJPEG、WEBP、非animated GIFが確認済み。
- `.gdoc`は公式非対応。connectorが対応を偽装せず、公式runtimeの拒否をそのままerrorにする。

## 責務境界

- connectorはpath、regular file、秘密filename、empty、件数、size、SHA-256、byte転送を検証する。
- file内容、UTF-8妥当性、画像、PDF、Office、archive、実行形式の内部構造は検証しない。
- known extensionは標準MIME、unknown extensionは`application/octet-stream`。
- 公式runtimeが拒否した形式は既存の`FILE_TYPE_NOT_SUPPORTED`／`UPLOAD_FAILED`として返し、別経路へfallbackしない。
- 「localで送信可能」と「ChatGPTが内容を解釈可能」を同一視しない。

## TODO

- [x] UTF-8 text専用allowlistとdecode検査を除去する。
- [x] text、image、PDF、Word、Excel、PowerPoint、archiveの一般的な拡張子へ標準MIMEを割り当てる。
- [x] 未知拡張子を`application/octet-stream`でpass-throughする。
- [x] 元bytes、size、SHA-256、順序、zero-fillを既存経路で維持する。
- [x] unit testで既知MIME、未知binary、不正UTF-8 textのbyte保持を固定する。
- [x] README、公開contract、RAGをpass-through契約へ更新する。
- [x] dry-runでknown text、known image、拡張子なしfileのMIMEとdigestを確認する。
- [x] `pnpm check`、`pnpm build`、`git diff --check`を通す。
- [x] scope外projectへ変更がないことを確認する。

## 非目標

- 各file typeのparser、magic、CRC、schema、macro、malware検査。
- 全形式を実ChatGPTへ個別uploadするmatrix。
- 公式runtimeが非対応のfileを解釈可能にする変換。
- connector上限を公式hard limitまで拡大すること。
- commit、push、npm publish、global install。

## 参照

- [OpenAI公式file type／limit記録](../../rag/chatgpt-app/raw/openai-chatgpt-file-upload-limits-retention-20260713.md)
- [Native attachment contract](../native-attachment-contract.md)

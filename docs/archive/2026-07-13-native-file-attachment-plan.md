# ChatGPT正規PNG添付 実装計画

作成日: 2026-07-13

状態: 完了

## 目的

`/Users/kite/Documents/gpt-connector`単体で、ローカルPNGを元bytesのままChatGPT通常Chatへ正規添付できるようにする。prompt本文への展開、DOM操作、OpenAI API、別経路へのfallbackは行わない。

## 責務境界

gpt-connectorが保証するのは、既存のworkspace境界とfile制限を通った`.png`を`image/png`として公式page runtimeへ渡すことまでである。画像として復号可能か、内容が正しいかはChatGPT runtimeの責務とする。

PNG signature、chunk、CRC、dimensions、画像内容はlocalで検査しない。破損画像の事前診断や偽装検出は今回の添付機能に必要なく、別要件として依頼された場合だけ扱う。

## 完了条件

- `.png`をUTF-8 decodeせず、元bytesとSHA-256を保持して既存chunk転送へ渡す。
- MIMEを`image/png`に固定する。
- workspaceRoot、相対path、symlink、regular file、秘密filename、空file、件数・size上限を既存textと同じように維持する。
- dry-runがname、relative path、bytes、MIME、SHA-256を返し、upload／conversationを作らない。
- productionの`consult`経路でPNGをuploadし、server attachment read-backとモデルの固定visual marker回答を確認する。
- model／effort一致、archive、session／operation／upload buffer 0を確認する。
- 既存text添付と全test、lint、typecheck、buildがgreenである。

## 非目標

- PNGのsignature、CRC、chunk構造、dimensions、画像内容のlocal検査。
- JPEG、WEBP、GIF、PDF、Office、音声、動画、archiveなど他形式の追加。
- 画像専用の複数file／同名file matrix。順序と重複は既存の汎用attachment契約をそのまま使う。
- upload fileの削除保証。conversation archiveとfile retentionを同一視しない。
- dotagents、ServerManager、その他projectの変更。
- Oracle置換、MCP登録切替、npm publish、global install、commit、push。

## TODO

### 成立調査

- [x] テキスト添付のproduction基準線と回帰testをgreenで固定する。
- [x] 自作PNG fixture `visual-marker.png`を用意し、22,427 bytes、`image/png`、SHA-256、固定marker `MARKER 7Q4M`を記録する。
- [x] DOM／file inputなしで公式runtime uploadが`ready`になることを確認する。
- [x] server read-backでname／MIMEが一致し、モデルが`MARKER 7Q4M`を回答することを確認する。
- [x] requested／resolved model `gpt-5-6-thinking`、effort `extended`、archive、bridge残存0を確認する。
- [x] token、cookie、account ID、conversation ID、server file IDを保存しない。

### 最小実装

- [x] `.png`を`image/png`として許可し、UTF-8 text検証から分離する。
- [x] PNG bytesを再encode・変換せず、既存SHA-256／chunk uploadへ渡す。
- [x] dry-runとconsult fingerprintへ既存file metadata契約をそのまま適用する。
- [x] text添付の挙動を変更しない。

### 安全網

- [x] 自作PNG fixtureのbytes、MIME、SHA-256とbinary保持をunit testで固定する。
- [x] `.bin`など未対応拡張子と、不正UTF-8 textが従来どおり拒否されることを維持する。
- [x] PNGは既存resolverのempty、size、root／symlink、秘密filename制限を通過してからtype分岐する。
- [x] 過剰に追加したmagic／CRC／dimensions検証testを残さない。

### 完了確認

- [x] production `consult`でPNG 1件のvisual marker、server read-back、model／effort、archive、残存0を再確認する。
- [x] README、公開attachment contract、RAG、INDEXを実装結果へ更新する。
- [x] `pnpm check`、`pnpm build`、`git diff --check`を通す。
- [x] scope外projectに変更がないことを確認する。

## 実測済みruntime差分

- image uploadの`fileSpec.mimeType`は未設定だが、元のbrowser `File.type=image/png`を使う既存normalizationでconversation MIMEは`image/png`になった。
- runtimeはwidth／heightを返さなかった。添付成立に不要なので公開契約へ追加しない。
- conversation archive後もupload file retentionは`unknown`、cleanupは`not_supported`である。

## 今回削除した過剰TODO

- magic bytesとMIMEの一致検証。
- PNG chunk／CRC／dimensions解析。
- 破損画像、偽装画像、追加画像形式の調査matrix。
- 第2画像形式、複数画像、text＋画像、同名画像ごとの実ブラウザprobe。
- 画像専用error codeや画像専用lifecycleの追加。

これらは正規添付の成立に必要ないため完了条件から外した。公式runtimeの明示エラーを既存の`FILE_TYPE_NOT_SUPPORTED`／`UPLOAD_FAILED`契約で返し、失敗を成功扱いや別経路で隠さない。

## 証拠

- [PNG E2E raw](https://github.com/kitepon/gpt-connector/blob/main/rag/chatgpt-app/raw/chatgpt-native-image-attachment-e2e-20260713.md)
- [Native attachment contract](../native-attachment-contract.md)

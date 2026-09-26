# ChatGPT WebのRspack実行構造と送信完了境界

- 出典: ログイン済み`chatgpt.com`専用Chromeで読み込まれたWeb runtimeをCDPのmain worldから観測。原文bundleは再配布せず、観測した構造と挙動だけ記録する。
- 取得日: 2026-09-26
- 確度: 再現済み。ChatGPTの非公開実装なので将来のbuildには一般化しない。

## 構造

- ページの`__reactRouterManifest.entry.imports`から、`__webpack_require__`をexportするassetを一意に見つけられる。この関数の`.m`はmodule factory、`.c`は実行済みmoduleのcacheである。
- 従来の直接ES module exportと異なり、会話送信・アップロード・モデル一覧・Maitaiのscope関数はcache中のmodule exportに分かれている。役割は関数source、export名、object形状、モデル一覧の読取りを組み合わせて検出した。
- 送信関数の`conversationMode`は文字列`primary_assistant`を受ける。旧形式の`{kind:"primary_assistant"}`を渡すと二重に包まれ、会話作成が422で拒否された。
- アプリの`AppScope`はReact contextにあるが、Maitaiのscope token、atom/store、scheduler、QueryClient、scope wrapperから独立したscopeを構成できる。DOM selectorやReact fiberを製品経路に持ち込まず、通常会話、2ターン継続、添付の送信・読戻しが成立した。

## 画像の完了境界

- 画像送信のPromiseは画像がサーバー側で生成された後もpendingになり得る。一方で`onCompletion("completed")`は最終画像メッセージより先に来ることがある。送信Promiseの終了と、このcallbackだけでは画像turnの完了を判定できない。
- 独立scopeの内部message mappingは、サーバーに最終画像が保存された後もassistantを`in_progress`のまま保持した実例がある。最終結果はサーバーのconversation mappingとLibraryのorigination IDを照合して読む。
- 生成中にconversation APIを短周期で読んだ試験では429が発生した。画像の読戻し間隔を空ける必要がある。通常会話ではcallback後の読戻しで終端を確認できた。
- 画像サブターンのassistantとtoolは指定modelとは別の`gpt-5-4-auto-thinking`名義だった。元の指定modelはconversation全体の`default_model_slug`にあり、user messageの`resolved_model_slug`は存在しなかった。

## 検証範囲

- 実測済み: モデル一覧、通常会話、同一会話への2ターン、テキスト添付のアップロード・送信・読戻し、会話のarchive。
- 生成済み画像の製品bridgeからの読戻し、PNG bytes／SHA-256照合、Libraryからのsoft deleteを確認。画像CLIも新規生成から保存・モデル／effort照合・会話archive・Library soft deleteまで完走した。

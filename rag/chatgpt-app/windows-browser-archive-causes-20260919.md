# Chromeの寿命とarchive失敗の原因調査

取得日: 2026-09-19。根拠: Windowsのjob API、Chromeの保存済みLog・Performance entry、対象テスト会話の公式API読戻し、製品の再現試験。確度: 以下の二つの欠陥は再現済み。当初の自然停止一件の終了主体は未記録。

## 回答失敗の実体

`smoke-095-postrestart-20260919-ruri824` は台帳上 `CHAT_FAILED`・`Something went wrong.` だったが、当該会話を照合すると、Proの回答 `再起動後の自動配送確認：瑠璃824` が `finished_successfully`・`end_turn: true` で保存されていた。

UTC 13:41:42.635に回答が確定し、13:41:43.521開始の `/backend-api/conversation/{id}` が約2秒後にHTTP 500を返していた。ChromeのLogとPerformanceの両方に500が残っていた。直後の同じ会話APIへの2要求は200で、最終的な `is_archived` はtrueだった。

回答生成後、添付0件の処理で残る通信はarchiveのPATCHとGETだけである。最初のarchive例外は、catch内で後片付けのarchiveが成功すると一般エラー `CHAT_FAILED` へ誤分類されていた。回答を生成できなかったという従来の説明は訂正する。元の通信のmethod・応答本文は残っておらず、OpenAI内部で500になった理由までは確認できない。

修理はarchive境界でエラーへ処理名とHTTP statusを付け、`ARCHIVE_FAILED` を維持する。401／403は既存どおり `AUTH_REQUIRED`。成功扱いや相談の自動再送は追加しない。

実機の新規テスト相談で、archiveの最初のPATCHだけにHTTP 500を注入した。回答の再送なしに `ARCHIVE_FAILED`・`HTTP 500 Something went wrong.` が返り、既存の後片付け後は保持session 0件、診断readyだった。

## Chromeの終了経路

修理前の専用ChromeはWindows jobへ所属していた。所属process一覧で調査用shellと同じjobにあることを確認し、job handleの所有者がCodexの `codex.exe`、制限値が `0x2000`（最後のjob handleを閉じると配下を終了）であることを確認した。

製品のWindows adapterはNode.jsの `spawn({detached:true, stdio:"ignore", windowsHide:true})` と `unref()` を使っていた。この指定はWindows jobの継承を解除しない。起動用shell単体を閉じる試験だけでは、Codexのjobを閉じる条件を検証できていなかった。

回帰試験では、専用の終了job内で製品adapterを呼び、起動元が終了しても生きている子が、jobを閉じた後に死亡することを修正前に再現した。修正後は同じ試験で生存し、日本語・空白・引用符・末尾のバックスラッシュを含む引数も維持した。

修理はWindows adapterの標準WMIによるprocess作成だけに置く。非表示・console非継承・jobからの独立を指定し、OSの作成結果を待つ。その後のCDP所有者・認証・window検証は既存の共通launcherが行う。[公式仕様](../setup/raw/windows-job-lifetime-20260919.md)を参照。

実機で修理後に専用Chromeを起動し、`IsProcessInJob` がfalse、Codexのjob所属一覧にも含まれないこと、browser startがstartedを返すことを確認した。正常Chromeや他のタスクのprocessは終了していない。

これでCodex終了に巻き込まれる欠陥は特定・修理できた。一方、UTC 13:04〜13:05に起きた当初の自然停止は、その瞬間のprocess終了記録とjob所有情報が残っていないため、同じ原因だったとは断定しない。Windowsイベント、Crashpad、更新ログ、Codexログにもその一件の終了主体を示す証拠はなかった。

## 検証

- archive API失敗とWindows jobの寿命試験は、修正前に失敗、修正後に成功。
- local release gate: lint・型検査・build成功。製品試験237件中220成功、失敗0、OS条件による17スキップ。
- hook試験とrelease gate試験は成功。公開版の導入・実機結果は公開後に追記する。

関連: [0.9.5の接続更新修理](async-consult-cdp-reconnect-20260919.md)、[起動処理の寿命試験](../../test/windows-browser-lifetime.test.ts)、[archive試験](../../test/page-bridge.test.ts)。

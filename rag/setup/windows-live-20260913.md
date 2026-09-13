# Windows live対応の実測（2026-09-13）

0.8.0のWindowsは登録・診断だけに対応し、browser startとCodex親のconsultをOS gateで拒否していた。
0.9.0でWindows adapterを追加する。Mac専用コード、会話runtime、添付、監視と配送RPCの挙動は維持する。

## 公式仕様と観測

- [Microsoft EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows) と [ShowWindowAsync](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindowasync): 専用PIDのChrome windowを列挙し、非表示／再表示後に読戻す。操作要求の受付だけで表示完了としない。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): 認証付きWebSocketと追加clientの公式受付。Windows同梱版で、認証なし401、認証ありinitialize成功を実測。Unix接続は私有directory検査で拒否されたため、Windowsの実装には採用しない。
- WindowsのCIM＋TCP所有情報の取得は約1.4秒。共通Macの500msを変更せず、Windows adapterが所有確認の待ち時間を持つ。
- [Microsoft Process実装](https://github.com/microsoft/referencesource/blob/main/System/services/monitoring/system/diagnosticts/Process.cs) と [FileStream実装](https://github.com/microsoft/referencesource/blob/main/mscorlib/system/io/filestream.cs): native exeから子stdinのBaseStreamへ短い要求を送ると、CopyToAsyncだけでは4096-byte bufferに残る。EOF前に応答する最小試験で再現し、ReadAsync→WriteAsync→FlushAsyncへ変更して成功。
- Windowsで管理者として作るfileはAdministratorsが所有者になる。UIDとの一致を要求せず、Windowsの所有者SIDとACLを検証する。任意userへ公開された接続情報を許可しない。
- PowerShellのstdoutは呼出し環境によって日本語が文字化けする。Windows専用helperでConsole.OutputEncodingとOutputEncodingをUTF-8に固定し、日本語・空白の往復を確認した。
- MSIXのresources/codex.exeを外部processから直接起動するとアクセス拒否になる。インストール済みDesktopのapp.asarを読取り確認すると、公式Desktop自身が4実行fileをLOCALAPPDATA/OpenAI/Codex/binへ展開し、内容hashごとのdirectoryから起動している。setupは既存の展開物を配布元4fileとSHA-256で照合して採用し、展開・更新は代行しない。この探索を含む実際のenable／disableで成功を確認した（GUI環境変数の書込みだけfixtureへ隔離）。

初回の専用Chromeで本人がログインした後、browser start再実行はalready_ready、model一覧取得と非表示中の最小Chatは成功した。
専用ChromeだけをCDPで終了し、cold start後も再ログインなしでstartedになることを確認した。
認証情報の複製、通常Chromeの操作、別サービスへの代替送信は行っていない。

確度: 記載した観測はこのWindows端末で再現確認済み。公開後・Desktop再起動後の受入は作業計画へ別記する。

# Windowsでの実利用対応（完了）

依頼: Windowsで動かないgpt-connectorを、この端末で利用できる状態へ修理する。

## 確認済みの原因

- 0.8.0の`browser start`はWindowsで`INVALID_INPUT`を返す。起動、所有PID確認、表示制御がmacOS専用。
- setupとfactory diagnosticsもWindowsをlive未対応としている。
- Codexのconsultは親への自動配送にmacOS専用のprocess/socketを要求する。
- この端末にChromeはあるが、製品専用browser profileはない。初回ログインは利用者が行う。

## 実施と受入

1. Windowsの標準機能で専用Chromeの起動、所有確認、非表示、ログイン用表示を実装する。
2. setup、診断、MCPのWindows実行を確認する。Codexへの回答配送は同梱公式CLIの対応transportを実測して決める。
3. 対象試験、型検査、lint後に最終の関連全体検証と3OS CIを通す。
4. mainへ通常pushし、npm公開、公式入口からWindows導入、model取得と最小Chatを実測する。

初回ログインは人の操作待ち、それ以外の実装・判定・公開は親が実行する。依存する起動・認証・MCPを同じ端末で検証するため実装は直列。Latticeと複数writerは使用しない。
通常Chromeのprofile・認証情報をコピーしない。Linux対応や会話runtimeの方式変更は含めない。
所有PID、引数の空白・日本語、他profile／port衝突、ログイン後の再実行、回答回収を検証する。

## 実測済み

- Windowsで専用Chromeの起動、所有PID照合、非表示、ログイン用表示が成功。本人ログイン後の再実行はalready_ready。
- live model取得と非表示中の最小Chatが成功（回答「確認済み」）。会話runtimeは未変更。
- Windowsのnative launcherで空白・日本語・引用符・末尾backslashの保持、EOF前の入力転送を確認。
- 同梱公式CLIのinitialize、認証付き追加接続、親processからの接続記録探索、他user公開ACLの拒否、EOF後のprocess終了と接続情報削除を確認。
- Windows setupの再実行、ready、解除、所有外の起動設定との衝突をfixtureで確認。
- MSIXの配布元と公式Desktopの実行用コピーを照合する探索を実装し、実binaryを使うsetupのenable／disableまで成功。GUI環境変数への書込みはこの試験ではfixtureへ隔離した。
- 専用Chromeを終了してcold startし、再ログインなしでstartedを確認。
- 独立反証でMac挙動差なし。Windows stdinの.NET bufferによる停止を最小試験で再現し、明示Flushで修理した。
- 最終のlocal gateはlint・型検査・203試験成功、15件はOS等の条件によりskip。build、release gateの5試験、npm packの136fileも確認。
- [mainのCI](https://github.com/kitepon/gpt-connector/actions/runs/34756845347)でMac・Windows・Linuxの製品試験とrelease commit gateが成功。

- [tagのCI](https://github.com/kitepon/gpt-connector/actions/runs/34756973553)とnpm publishが成功し、registryの0.9.0も取得確認。[GitHub Release](https://github.com/kitepon/gpt-connector/releases/tag/v0.9.0)を公開。
- repository外から`npx --yes gpt-connector@0.9.0 setup`を実行し、global版0.9.0を導入。4AIの既存設定・登録は照合値が一致し、MCPの版・7 tools・診断・state・liveはready。
- 公開版のmodelsとChatが成功。日本語の入力・返信は正式版CLIのstdoutをUTF-8で直接受け取り、「日本語確認済み」と一致、finished_successfully・endTurn=trueを確認。
- 公開版の`setup --check`はaction_required。未反映はCodex起動設定だけで、codexSteer=restart_required。他の診断はready。

## 再起動後の最終確認

利用者の再起動後、公式入口のsetupが専用Chromeを再ログインなしで起動した。
公開版0.9.0の`setup --check`はoverall=ready。4AIすべてのMCP・liveとCodexのSteerがreadyになった。
このCodexタスクから公開MCPのconsultを一回実行し、「Windows自動配送確認済み」という返信を同じタスクで自動受信した。
台帳もstate=succeeded、delivery.state=submitted、finished_successfully、endTurn=true、error=null。試験会話のarchiveも完了。

現在地: Windows対応の公開・導入・実機検証は完了。Mac専用実装と共通の会話処理は維持し、3OS CIも成功した。

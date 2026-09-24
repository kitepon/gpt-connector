# Windows SSHからの専用Chrome表示

- 出典: [Windows sessionと対話taskの一次資料](raw/windows-session-task-20260924.md)およびWindows実機。2026-09-24取得・実測。確度: 実機で再現・修正後確認。

SSHのPowerShellはsession 0、専用Chromeはログイン中ユーザーのsession 1にいた。SSH側で`EnumWindows`を呼ぶと対象windowは0件だった。ChromeのCDP targetは存在し、`grok-doctor`は`AUTH_REQUIRED`まで到達していたため、接続や所有確認の故障とは分離できた。

同じユーザーの`Interactive` scheduled taskから正規`browser show --provider grok`を実行すると`shown`になった。Windows adapterで対象Chromeと呼出元のsessionを照合し、異なる場合だけwindow操作を対話taskで実行するよう変更。修正版packageをWindowsへ一時導入し、SSHから`browser start --provider grok`が`already_ready`、続く`browser show --provider grok`が`shown`になった。taskと一時記録は残らなかった。

利用者のログイン後、公開版0.12.0の`grok-doctor`は`ready`になり、`grok-chat --mode expert`へ送った短文は`WINDOWS_EXPERT_OK`、`requestedMode=expert`、`reportedModel=grok-4`、`resolvedEffort=high`で返った。`resolvedModel`は`null`だった。

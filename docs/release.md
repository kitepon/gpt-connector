# Release

gpt-connectorのreleaseはこのrepositoryが所有する。dotagentsは工場統合後のcompatibility確認を行えるが、
version決定、製品gate、npm公開、tag／GitHub Release、公開後smokeの正本ではない。

## Version同期

新versionでは次を同じ値へ更新する。

- `package.json`
- `src/version.ts`
- `README.md`の現行版記載
- `docs/ai-installer-setup-contract.md`のversion指定例
- `CHANGELOG.md`の新version見出しと日付

`pnpm-lock.yaml`はroot package versionを保持しない。依存graphが変わった場合だけ更新する。

同じversionを再公開しない。公開後に欠陥が見つかった場合は次のpatchへ進め、必要なら欠陥版をnpmでdeprecateする。

## Local gate

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm build
corepack pnpm test:codex-hooks
corepack pnpm test:release-gate
npm pack --dry-run --json
```

`test:release-gate`はrelease commit gateの単体試験であり、fixture repository内の成功・拒否条件だけを検査する。現在のworktreeは判定しない。
対象commitを`main`へpushすると、CIの`release-commit` jobがMac・Linux・Windowsの製品試験後にclean checkoutで実gateを通す。
手元でも同じ入口を実行できる。

```bash
git fetch origin
corepack pnpm verify:release-commit
```

`verify:release-commit`はpublish対象が`origin/main`の祖先であり、tracked／untracked差分のないworktreeから
payloadを作ることを要求する。この入口自身が`origin/main`を取得してから判定する。CIの`release-commit` job、
packageの`prepublishOnly`、tag CIのpublish jobは同じ入口を使う。

## Cloud publish

npmのprovenanceはGitHub ActionsのOIDCから作る。local shellでは`npm publish`を実行しない。
npm Trusted Publisherはrepository `kitepon/gpt-connector`、workflow `.github/workflows/ci.yml`へ設定する。

1. `package.json`と同じversionの`v<version>` tagを、検証済みのmain commitへ付けてpushする。
2. tag起点のCIがMac・Linux・Windowsのfull gateを再実行する。
3. full gate後、同じworkflowの`publish` jobがtagとpackage version、`origin/main`祖先、pack payloadを検証し、`npm publish --provenance --access public`を実行する。
4. npmに同versionが既に存在する再実行ではpublishだけをskipし、versionを上書きしない。
5. tag CIとnpm registryを確認した後、同じtagへGitHub Releaseを公開する。

```bash
release_version=$(node -p "require('./package.json').version")
release_commit=$(git rev-parse HEAD)
git tag "v$release_version" "$release_commit"
git push origin "v$release_version"
run_id=$(gh run list --workflow ci.yml --commit "$release_commit" --event push --limit 1 --json databaseId --jq '.[0].databaseId')
test -n "$run_id"
gh run watch "$run_id" --exit-status
test "$(npm view "gpt-connector@$release_version" version)" = "$release_version"
gh release create "v$release_version" --target "$release_commit" --generate-notes
```

## 公開後smoke

公開npm packageをAitermの永続PTYから公式導入し、setupと診断を確認する。現在の端末はローカルで操作し、別端末に限りSSH接続する。
WindowsではPowerShell 7を使う。同一端末の共有AI設定への導入は他製品と並行しない。

```bash
release_version=$(node -p "require('./package.json').version")
npm install --global "gpt-connector@$release_version"
gpt-connector setup
gpt-connector --version
gpt-connector setup --check
```

初回の公開入口`npx --yes gpt-connector@<公開版> setup`も確認する。Mac、Windows、Linuxではlive readinessまで実測する。
Linuxは公式Google ChromeとローカルX11が前提で、Codexへの自動Steerは未対応のまま別記する。X11が無い環境だけlive未対応の`partial`／終了2を別記する。
Codexのhook・旧起動設定を変更した場合は、完全再起動後の配送確認まで行う。再起動待ちは`action_required`と区別する。
各AI自身でも登録を確認する（Claude `mcp get`、Codex `mcp get --json`、Grok `mcp doctor --json`、Cursor `mcp list-tools`）。
`sessions`の読取りは製品所有の隔離fixtureで確認し、利用者のjob内容を公開しない。
設定更新前後で既存env、モデル、認証、他MCPが保持されたこと、setup再実行で変更が増えないことを確認する。

さらにread-only MCP initialize／tools listがstderrを汚さず、13 toolsとprovider別の
discovery契約を維持することを確認する。Chrome runtimeへ変更があるreleaseだけ、専用profileで
`browser start`、`models`、hidden中の最小Chat、必要時の`browser show`を実行する。Grok runtimeへ変更があるreleaseでは`browser start --provider grok`、`grok-modes`、最小の`grok-consult`と`grok-close`も確認する。

## 巻き戻し

npm versionとtagは移動・上書きしない。利用環境は直前の正常versionを明示installして戻せる。
state schema／migrationを変更したreleaseでは、旧versionへ戻せる条件をCHANGELOGへ明記してから公開する。

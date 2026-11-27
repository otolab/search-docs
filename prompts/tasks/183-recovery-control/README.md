# Issue #183: 隔離した再現試験

Issue #183 の現行挙動を、専用の一時ディレクトリと実プロセスで確かめるための調査用 harness です。製品コードや Issue #180 の受け入れ条件は変更しません。試験結果は現行方式の採用承認を意味しません。

## 実行環境

- macOS または Linux の単一ホスト
- リポジトリの依存関係と Python virtualenv が準備済み
- workspace の `pnpm build` が完了し、`packages/*/dist` が最新
- ループバック HTTP server と子プロセス起動が可能

2026-11-27 の確認環境: Node.js 24.16.0、pnpm 9.14.4、Python 3.11.13、LanceDB 0.30.2、PyArrow 22.0.0。

## コマンド

リポジトリ root から実行します。

```sh
node prompts/tasks/183-recovery-control/lock-control.mjs
node prompts/tasks/183-recovery-control/recreate-recovery.mjs
node prompts/tasks/183-recovery-control/writer-stop-unconfirmed.mjs
```

実行環境が loopback bind を制限する場合は、承認された sandbox 外の環境から同じコマンドを実行してください。試験は `os.tmpdir()` 以下に一時 DB / project を作り、終了時に削除します。製品ソースを編集しません。DB 初期化と maintenance lock の SIGKILL 試験では、テスト専用の複製コードに pause point を挿入します。

## 試験範囲と限界

- `lock-control.mjs`: 現行 lock の一時複製を使い、gate / users / exclusive / incomplete 作成点で SIGKILL。別 process の shared/exclusive 競合を20回実施します。
- `recreate-recovery.mjs`: 実 LanceDB を使い、`sections` 作成後の partial-init DB と `exclusive + incomplete` の残存状態から `index recreate` を実行します。現在の source がない場合に index tree が変わらず拒否されること、source が戻れば全再構築できること、known-good backup の復元後も `incomplete` が shared registration を止めることを確認します。Embedding endpoint は loopback fake で、固定ベクトルを返し、実モデル推論を行いません。
- `writer-stop-unconfirmed.mjs`: 実 MCP service / DBEngine を起動し、writer 前診断の停止を一時 bundle 内の hook で失敗させます。診断 worker を生存させた状態で SIGTERM を送り、MCP の shared registration が残ることと writer が `WATCHING` に入らないことを確認します。EPERM は harness で注入する OS fault です。

この harness が扱うのは単一 host のローカル一時 filesystem と SIGKILL / fault injection です。OS crash・電源断、native LanceDB create/index 操作の途中、network/shared filesystem、multi-host、Windows の保証には一般化できません。backup restore 後に残る maintenance marker をどう解除するかは未承認の製品仕様であり、この試験は marker を消しません。

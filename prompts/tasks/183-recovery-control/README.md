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
node prompts/tasks/183-recovery-control/http-shutdown-unconfirmed.mjs
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/scalar-index-failure.py
node prompts/tasks/183-recovery-control/cleanup-failure.mjs
pnpm --dir packages/db-engine exec vitest run --config vitest.config.maintenance.ts src/typescript/__tests__/process-tree.test.ts
pnpm --dir packages/mcp-server exec ../../node_modules/.bin/vitest run --config vitest.config.maintenance.ts src/maintenance/__tests__/parallel-mcp-startup.test.ts
```

実行環境が loopback bind を制限する場合は、承認された sandbox 外の環境から同じコマンドを実行してください。試験は `os.tmpdir()` 以下に一時 DB / project を作り、終了時に削除します。製品ソースを編集しません。DB 初期化と maintenance lock の SIGKILL 試験では、テスト専用の複製コードに pause point を挿入します。

`recreate-recovery.mjs` は `embedding_identity`、各必須 table、`index_requests.status` index の作成完了境界で停止できます。既存の5 MCP integration test も package cwd と maintenance 用 config を指定して単独実行できます。通常の config は実モデル用 global setup を起動するため、このテストには使いません。テストは `dist/server.js` を実行するので、同じ checkout の `pnpm build` 後に実施し、実行時の HEAD / dist の対応を結果と一緒に記録してください。script 自身は dist と source の一致を証明しません。

全 harness は起動した直接 child を追跡し、cleanup で終了イベントを確認してから一時 root を消します。writer harness は別 process group の診断 child も PID を stderr 到着時に記録し、終了を確認します。`cleanup-failure.mjs` は child 起動後に意図的な assertion failure を起こし、この cleanup 順序を確かめます。終了を確認できないときは DB 等の一時資材を残し、cleanup failure と一時 root の場所を報告します。

`scalar-index-failure.py` は実 LanceDB の disposable DB に各5,000行を入れ、現行 `SearchDocsWorker.init_tables()` の `index_requests.status` scalar-index 作成時だけ例外を注入します。必須 table が揃った状態で read-only strict 診断を行い、filter 結果と論理行 hash を比較した後、次回初期化で index が作られることを確認します。実行時間は1回の小規模な観測値であり、性能ベンチマークではありません。LanceDB native API 呼び出し中のクラッシュは注入しません。

`http-shutdown-unconfirmed.mjs` は実 HTTP server / DBEngine / CLI stop を disposable project で起動し、writer 前の strict 診断 subprocess を停止位置で止めてから実際の CLI stop を実行します。一時コピーの `strict-diagnostic.js` にだけ pause hook を追加します。Loopback bind が制限される環境では、承認された sandbox 外で実行してください。macOS で `kill(-PGID, 0)` が `EPERM` を返した場合は `ps` から同じ process group の有無を確認し、消失を確認できなければ一時 DB を残します。この試験は signal 送信の EPERM 注入ではなく、HTTP shutdown が停止中の診断 worker をどう扱うかを観測します。

## 試験範囲と限界

- `lock-control.mjs`: 現行 lock の一時複製を使い、gate / users / exclusive / incomplete 作成点で SIGKILL。別 process の shared/exclusive 競合を20回実施します。
- `recreate-recovery.mjs`: 実 LanceDB を使い、identity、各必須 table、`index_requests.status` index の作成完了直後に SIGKILL する matrix を作ります。各 DB の table 構成、strict 診断の成否、診断前後の tree hash を確認した後、`sections` 作成後の DB で `index recreate` と backup restore の条件を試します。現在の source がない場合に index tree が変わらず拒否されること、source が戻れば全再構築できること、known-good backup の復元後も `incomplete` が shared registration を止めることを確認します。Embedding endpoint は loopback fake で、固定ベクトルを返し、実モデル推論を行いません。
- `scalar-index-failure.py`: 必須 table がある DB で1つの index 作成例外を注入し、残る index 作成・strict 診断・filter 結果・論理行 hash・次回再試行を確認します。DB worker 内の直接呼び出しなので TypeScript service の writer 開始や本番データ規模は対象外です。
- `writer-stop-unconfirmed.mjs`: 実 MCP service / DBEngine を起動し、writer 前診断の停止を一時 bundle 内の hook で失敗させます。診断 process group の signal-0 存在確認は通し、SIGTERM 送信だけが EPERM になるよう注入します。子が生存したまま親へ SIGTERM を送り、shutdown 後の registration・exclusive・writer 起動を観測します。EPERM は harness の fault injection であり、OS 権限や実運用の process ownership 条件を再現したものではありません。
- `http-shutdown-unconfirmed.mjs`: HTTP server と CLI stop を実際に動かし、診断 worker が停止位置で生きている状態で `/shutdown` を処理させます。HTTP応答、親 exit、CLIの成功報告、PID file、diagnostic child group、shared registration、exclusive取得の結果を記録します。pause した診断 worker に対して `/shutdown` route が signal を送る状況は作らず、コードが shutdown 中にその worker を待つかどうかを試します。
- `process-tree.test.ts`: disposable process group に signal-0 / SIGTERM 送信時の EPERM を別々に注入し、停止未確認の rejection と shared registration が exclusive を止めることを確認します。通常 config は embedding server 用 global setup を起動するため、`vitest.config.maintenance.ts` を指定します。

writer service harness は `shutdownFailureReported` と `selectedShutdownDirectionObserved` も出力します。これは operator が選んだ「停止未確認なら失敗を返し、共有登録を保持する」方向と現行挙動を比較する観測値です。テスト結果から仕様の実装承認を推定しません。

この harness が扱うのは単一 host のローカル一時 filesystem と、identity/table/index の各操作が完了した境界での SIGKILL / fault injection です。native LanceDB create/index 操作の最中、OS crash・電源断、network/shared filesystem、multi-host、Windows の保証には一般化できません。backup restore 後に残る maintenance marker をどう解除するかは未承認の製品仕様であり、この試験は marker を消しません。

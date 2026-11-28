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
node prompts/tasks/183-recovery-control/embedding-identity-mismatch-cleanup.mjs
node prompts/tasks/183-recovery-control/heartbeat-stale-writer-write.mjs
node prompts/tasks/183-recovery-control/source-dist-check.mjs
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/scalar-index-failure.py
node prompts/tasks/183-recovery-control/cleanup-failure.mjs
pnpm --dir packages/db-engine exec vitest run --config vitest.config.maintenance.ts src/typescript/__tests__/process-tree.test.ts
pnpm --dir packages/mcp-server exec ../../node_modules/.bin/vitest run --config vitest.config.maintenance.ts src/maintenance/__tests__/parallel-mcp-startup.test.ts
pnpm --dir packages/server exec vitest run --config vitest.config.heartbeat.ts src/__tests__/writer-heartbeat-integration.test.ts -t 'keeps a fresh writer and automatically takes over after expiry across timezones'
```

実行環境が loopback bind を制限する場合は、承認された sandbox 外の環境から同じコマンドを実行してください。試験は `os.tmpdir()` 以下に一時 DB / project を作り、終了時に削除します。製品ソースを編集しません。DB 初期化と maintenance lock の SIGKILL 試験では、テスト専用の複製コードに pause point を挿入します。

`recreate-recovery.mjs` は `embedding_identity`、各必須 table、`index_requests.status` index の作成完了境界で停止できます。既存の5 MCP integration test も package cwd と maintenance 用 config を指定して単独実行できます。通常の config は実モデル用 global setup を起動するため、このテストには使いません。テストは `dist/server.js` を実行します。実行時の HEAD / dist の対応は `source-dist-check.mjs` で確認できます。

`source-dist-check.mjs` は HEAD の tracked source を一時 checkout に展開し、現在の dependency directories を symlink で参照して TypeScript project build を行います。生成物は一時 checkout にだけ書き、現在の `packages/*/dist` と SHA-256 で比較します。package source または build 設定が未 commit の場合は停止します。成功時だけ自分が作った一時 checkout を削除し、build に失敗した場合は調査用に残した場所を表示します。

全 harness は起動した直接 child を追跡し、cleanup で終了イベントを確認してから一時 root を消します。writer harness は別 process group の診断 child も PID を stderr 到着時に記録し、終了を確認します。`cleanup-failure.mjs` は child 起動後に意図的な assertion failure を起こし、この cleanup 順序を確かめます。終了を確認できないときは DB 等の一時資材を残し、cleanup failure と一時 root の場所を報告します。

`scalar-index-failure.py` は実 LanceDB の disposable DB に各5,000行を入れ、現行 `SearchDocsWorker.init_tables()` の `index_requests.status` scalar-index 作成時だけ例外を注入します。必須 table が揃った状態で read-only strict 診断を行い、filter 結果と論理行 hash を比較した後、次回初期化で index が作られることを確認します。実行時間は1回の小規模な観測値であり、性能ベンチマークではありません。LanceDB native API 呼び出し中のクラッシュは注入しません。

`http-shutdown-unconfirmed.mjs` は実 HTTP server / DBEngine / CLI stop を disposable project で起動し、writer 前の strict 診断を一時コピーの `strict-diagnostic.js` 内で pause させます。実 CLI process 内の `fetch` response を記録するため、server route を改変せず実際の status / headers / body を観測します。加えて read-only `DBEngine` で heartbeat row を前後に読み、server log の claim readback と `WATCHING` 行を確認します。shutdown 直後の診断 process group と、その後の短い継続観測を分けて記録します。Loopback bind が制限される環境では、承認された sandbox 外で実行してください。macOS で `kill(-PGID, 0)` が `EPERM` を返した場合は `ps` から同じ process group の有無を確認し、消失を確認できなければ一時 DB を残します。この試験は signal 送信の EPERM 注入ではありません。

## 試験範囲と限界

- `lock-control.mjs`: 現行 lock の一時複製を使い、gate / users / exclusive / incomplete 作成点で SIGKILL。別 process の shared/exclusive 競合を20回実施します。さらに、shared registration 完了後に owner process を SIGKILL し、残った entry が exclusive maintenance を拒否する一方、同じ identity の shared process は参加できること、別 identity は拒否されること、自動回収されないことを確認します。
- `recreate-recovery.mjs`: 実 LanceDB を使い、identity、各必須 table、`index_requests.status` index の作成完了直後に SIGKILL する matrix を作ります。各 DB の table 構成、strict 診断の成否、診断前後の tree hash を確認した後、`sections` 作成後の DB で `index recreate` と backup restore の条件を試します。現在の source がない場合に index tree が変わらず拒否されること、source が戻れば全再構築できること、known-good backup の復元後も `incomplete` が shared registration を止めることを確認します。Embedding endpoint は loopback fake で、固定ベクトルを返し、実モデル推論を行いません。
- `recreate-recovery.mjs` の recovery fixture は、使い捨て project に `source.md` と LanceDB を作り、`sections` table 作成完了後に SIGKILL します。別の fixture child が `exclusive` と `incomplete` を作ってから SIGKILL された後、`users` が空であることを確認し、この fixture の `exclusive` directory だけを手動削除します。再構築試験では source を一時削除して preflight 拒否・index hash 不変を確認し、source を戻して全再構築します。backup 試験では正常完了した同一 fixture の `index` と `documents` をコピーして backup にし、partial DB と incomplete を作り、source を削除して recreate を拒否させます。その後、fixture の partial `index` と `documents` を削除し、known-good backup の2 directory をコピーで戻します。strict diagnosis は通りますが `incomplete` は残り、shared registration は拒否されます。これは fixture 上で明示的に行った手順であり、製品の stale lock 回収や backup restore 完了手順ではありません。
- `scalar-index-failure.py`: 必須 table がある DB で1つの index 作成例外を注入し、残る index 作成・strict 診断・filter 結果・論理行 hash・次回再試行を確認します。DB worker 内の直接呼び出しなので TypeScript service の writer 開始や本番データ規模は対象外です。
- `writer-stop-unconfirmed.mjs`: 実 MCP service / DBEngine を起動し、writer 前診断の停止を一時 bundle 内の hook で失敗させます。診断 process group の signal-0 存在確認は通し、SIGTERM 送信だけが EPERM になるよう注入します。子が生存したまま親へ SIGTERM を送り、shutdown 後の registration・exclusive・writer 起動を観測します。EPERM は harness の fault injection であり、OS 権限や実運用の process ownership 条件を再現したものではありません。
- `http-shutdown-unconfirmed.mjs`: HTTP server と CLI stop を実際に動かし、diagnostic Python worker が pause 中に `/shutdown` を処理させます。実 HTTP status/body、親 exit、CLI 成功報告、PID file、diagnostic process group の即時状態と短時間後の状態、heartbeat claim、`WATCHING` log、shared registration、exclusive 取得結果を記録します。pause worker へ `/shutdown` route が signal を送る状況は作りません。
- `process-tree.test.ts`: disposable process group に signal-0 / SIGTERM 送信時の EPERM を別々に注入し、停止未確認の rejection と shared registration が exclusive を止めることを確認します。通常 config は embedding server 用 global setup を起動するため、`vitest.config.maintenance.ts` を指定します。
- `parallel-mcp-startup.test.ts`: 同一 project の5 MCP process を同時起動し、shared 利用中の exclusive が拒否されること、別の起動途中 process を SIGKILL した後も既存利用者を残したまま同一 identity で再接続できることを確認します。SIGKILL 時点は external fake embedding endpoint の health probe 中で、local embedding child / writer の停止未確認を試していません。`worker.enabled` と `watcher.enabled` は無効です。
- `writer-heartbeat-integration.test.ts` の上記単独 case: disposable LanceDB と fake embedding endpoint で別 process の DBEngine worker が接続中のまま heartbeat lease を期限切れにし、新 Watcher が claim / `WATCHING` に進む既存挙動を確認します。旧 process は継続 heartbeat / indexing を行わず、二重の active writer を試すものではありません。sandbox の loopback 制限時は同じ許可済み sandbox 外の実行環境が必要です。
- `embedding-identity-mismatch-cleanup.mjs`: 実 MCP / DBEngine / `MaintenanceLock` を disposable project で起動します。実際の local embedding executable だけを固定 `/health`・`/ready` 応答の test child に置き換え、DB 側に別の embedding identity を用意します。child の SIGTERM 送信を fixture PID に限って EPERM にする fault injection の後、identity mismatch、DBEngine worker の停止、shared users の解放、child が HTTP 応答を続ける状態、exclusive 取得を個別に観測します。child の DB path 引数と open file も照合します。maintenance operation 自体は実行せず、対象 child の PID / process group を確認できた場合だけ cleanup します。macOS の signal-0 が `EPERM` の場合は `ps` で同一 group を確認し、状態が確定できなければ root を保持します。embedding model の実 process / 推論や実運用の OS 権限エラーを再現する試験ではありません。
- `heartbeat-stale-writer-write.mjs`: disposable LanceDB を二つの実 `DBEngine` process で開き、旧側が一度記録した heartbeat の lease を3秒に短縮して自然失効させます。新 `WatcherProcess` が `WATCHING` になった後、旧側の接続を保ったまま `createIndexRequest` を1回だけ順次実行し、新規 read-only DBEngine で保存を確認します。二つ目の稼働 Watcher、連続書込み、同時 native commit は作りません。この結果は heartbeat が個別 DBEngine write を fence しないことを示すもので、二重 writer 時の LanceDB / indexing safety を証明しません。

`writer-stop-unconfirmed.mjs` は `shutdownFailureReported` と `selectedShutdownDirectionObserved` も出力し、停止未確認時に親終了・共有登録保持を選ぶ operator 方向と現行挙動を照合します。`embedding-identity-mismatch-cleanup.mjs` は別途、startup identity mismatch 中の local embedding test child 停止失敗、registration 解放、exclusive 取得を測ります。親終了後の child 再利用はどちらも試していません。観測結果は仕様の実装承認を意味しません。

inq-11 の確認では、同一 identity の stale registration、5 MCP 並列・再接続、停止失敗を注入した identity mismatch 起動、期限切れ heartbeat takeover と takeover 後の単発旧 DBEngine write を組み合わせます。これにより shared admission / maintenance exclusion / lease takeover と startup cleanup の境界を個別に観測しますが、停止未確認 child を伴う実 embedding runtime の再起動や、二つの active Watcher が同時に native write する場合の safety は証明しません。strict diagnosis は maintenance registration と child owner を調べません。

この harness が扱うのは単一 host のローカル一時 filesystem と、identity/table/index の各操作が完了した境界での SIGKILL / fault injection です。LanceDB 0.30.2 の Python `create_scalar_index()` は Rust 側の async `create_index()` を待つ wrapper で、公開 Python API に native operation の内部 pause / progress hook はありません。時間を見計らって kill する方式では、API 呼出し前・処理中・完了後のどこで停止したかを決定的に識別できず、安全な crash-matrix 試験とはみなしません。native API 内部の停止を再現するには disposable DB 上で使える専用 failpoint が必要ですが、現状その機構はなく、OS crash・電源断、network/shared filesystem、multi-host、Windows の保証にも一般化できません。backup restore 後に残る maintenance marker をどう解除するかは未承認の製品仕様であり、この試験は marker を消しません。

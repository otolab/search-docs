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
node prompts/tasks/183-recovery-control/bootstrap-recheck-control.mjs
node prompts/tasks/183-recovery-control/shared-holder-liveness.mjs
node prompts/tasks/183-recovery-control/manual-registration-removal.mjs
node prompts/tasks/183-recovery-control/recreate-recovery.mjs
node prompts/tasks/183-recovery-control/writer-stop-unconfirmed.mjs
node prompts/tasks/183-recovery-control/http-shutdown-unconfirmed.mjs
node prompts/tasks/183-recovery-control/embedding-identity-mismatch-cleanup.mjs
node prompts/tasks/183-recovery-control/heartbeat-stale-writer-write.mjs
node prompts/tasks/183-recovery-control/source-dist-check.mjs
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/scalar-index-failure.py
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/lancedb-read-write-control.py
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/search-docs-periodic-maintenance-reader.py
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/search-docs-10m-vector-retention.py
packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/search-docs-worker-periodic-retention.py
node prompts/tasks/183-recovery-control/cleanup-failure.mjs
pnpm --dir packages/db-engine exec vitest run --config vitest.config.maintenance.ts src/typescript/__tests__/process-tree.test.ts
pnpm --dir packages/mcp-server exec ../../node_modules/.bin/vitest run --config vitest.config.maintenance.ts src/maintenance/__tests__/parallel-mcp-startup.test.ts
pnpm --dir packages/server exec vitest run --config vitest.config.heartbeat.ts src/__tests__/writer-heartbeat-integration.test.ts -t 'keeps a fresh writer and automatically takes over after expiry across timezones'
```

実行環境が loopback bind を制限する場合は、承認された sandbox 外の環境から同じコマンドを実行してください。試験は `os.tmpdir()` 以下に一時 DB / project を作り、終了時に削除します。製品ソースを編集しません。DB 初期化と maintenance lock の SIGKILL 試験では、テスト専用の複製コードに pause point を挿入します。

`recreate-recovery.mjs` は `embedding_identity`、各必須 table、`index_requests.status` index の作成完了境界で停止できます。既存の5 MCP integration test も package cwd と maintenance 用 config を指定して単独実行できます。通常の config は実モデル用 global setup を起動するため、このテストには使いません。テストは `dist/server.js` を実行します。実行時の HEAD / dist の対応は `source-dist-check.mjs` で確認できます。

`source-dist-check.mjs` は HEAD の tracked source を一時 checkout に展開し、現在の dependency directories を symlink で参照して TypeScript project build を行います。生成物は一時 checkout にだけ書き、現在の `packages/*/dist` と SHA-256 で比較します。package source または build 設定が未 commit の場合は停止します。成功時だけ自分が作った一時 checkout を削除し、build に失敗した場合は調査用に残した場所を表示します。

全 harness は起動した直接 child を追跡し、cleanup で終了イベントを確認してから一時 root を消します。writer harness は別 process group の診断 child も PID を stderr 到着時に記録し、終了を確認します。`cleanup-failure.mjs` は child 起動後に意図的な assertion failure を起こし、この cleanup 順序を確かめます。終了を確認できないときは DB 等の一時資材を残し、cleanup failure と一時 root の場所を報告します。

`bootstrap-recheck-control.mjs` は二つの独立した local process が空の disposable DB を read-only の directory observation で同時に確認した後、同じ既存 `MaintenanceLock` API で初期 exclusive を競います。勝者だけが fixture table を作り、待機側は exclusive を取得してから table directory を再読し、作成を重ねず shared 利用へ進むことを確認します。table schema は必要 table 名だけを模した単純な fixture で、実 `SearchDocsWorker` の identity / schema / scalar-index 初期化ではありません。lock source は一時 ESM に transpile し、DB と lock は一時 root に閉じます。失敗時は harness が起動した専用 process group の停止を確認し、確認できない場合は root を残します。この試験は提案する wait/recheck 順序の制御例であり、現行 MCP / HTTP startup がこの順序で動くこと、durable transition state、SIGKILL 後 recovery、fsync / 電源断を証明しません。

`shared-holder-liveness.mjs` は、初期化候補が空 DB を read-only で観測した後、先行側が排他下で fixture table を作り、排他を解放して長期 shared 利用に入った状況を作ります。待機側が stale preflight のまま exclusive だけを再試行すると、shared 利用が続く間は毎回拒否され、shared を解放して初めて排他取得後の再確認に進めることを別 process で確認します。既存 `MaintenanceLock` source の一時 ESM copy と synthetic table directory のみを使い、実 service / worker / LanceDB initialization は行いません。これは進行性の反例を示す制御試験であり、どの製品 admission / handoff を採用するかは決めません。

`scalar-index-failure.py` は実 LanceDB の disposable DB に各5,000行を入れ、現行 `SearchDocsWorker.init_tables()` の `index_requests.status` scalar-index 作成時だけ例外を注入します。必須 table が揃った状態で read-only strict 診断を行い、filter 結果と論理行 hash を比較した後、次回初期化で index が作られることを確認します。実行時間は1回の小規模な観測値であり、性能ベンチマークではありません。LanceDB native API 呼び出し中のクラッシュは注入しません。

`lancedb-read-write-control.py` は一時 DB に小さな table を作り、同一 process 内の独立した writer / reader connection から通常の `add` と read-only query を重ねます。さらに別の使い捨て DB では、別 process が古い table version を開いたまま writer が overwrite と `optimize(cleanup_older_than=0)` を実行し、その reader の結果を観測します。子 process の終了を確認してから temp root を削除し、終了未確認なら root を残します。読み取り中の例外、観測行数の後退、読み取りだけを行った前後の DB file hash 差分、通常 append による file 増加、cleanup 中の old-version read の結果を記録します。いずれも単一回の局所制御試験であり、search-docs の maintenance admission、他 filesystem / host、native API 中断、電源断の安全性を証明しません。

`search-docs-periodic-maintenance-reader.py` は pinned LanceDB の disposable DB 上で実 `SearchDocsWorker.init_tables()` と `add_sections()` を使います。100回の append 中、worker が実際に呼ぶ20回ごとの `optimize(cleanup_older_than=10分)` の前後で DB file snapshot を取り、別 process の old-version reader を並行させます。old reader は各 maintenance 呼出し内に完了した read/query の時刻も記録し、新しい reader process は20回ごとの境界で起動します。100回目の製品コードは `table.optimize.compact_files()` の属性参照が失敗し、warning を出すところまでを記録します。pinned LanceDB 0.30.2 で実在する `Table.compact_files()` はdeprecated APIとして別途 disposable DB 上で呼び、file snapshot と reader を観測します。最後に同じ writer 結果を複製し、一方は old reader を開いたまま、もう一方は reader なしで `optimize(cleanup_older_than=0)` を実行します。cleanup 前後の versions・file snapshot と old/new reader の結果を記録します。即時 cleanup と `Table.compact_files()` は製品コードの周期設定を変更するものではなく、局所比較用の制御です。reader query が native 呼出しの時間区間に入った場合だけ overlap と数えます。この試験は一つの local DB / LanceDB version / writer に限定され、二重 writer、native API 内部 failpoint、他 filesystem / host、OS crash / 電源断の安全性を証明しません。

`search-docs-10m-vector-retention.py` は新しい disposable DB だけを使い、実 `SearchDocsWorker.add_sections()` を100回実行した後、pinned version が10分を超えるまで別 process の reader から `table.search(query_vector)` を行います。writer は既存の20回ごとの production `optimize(cleanup_older_than=10分)` を通り、10分を超えた後に新しい version を追加して、同じ10分 retention で cleanup を一度明示実行します。前後の version 一覧・file snapshot、旧 pinned version の残存、旧 reader と新 reader の vector search 結果を記録します。query interval と optimize 呼出しの wall-clock 区間が重なったかも数えますが、LanceDB native operation 内部の実行区間は観測しません。試験は10分を超えて実時間待機し、fixture vectors の exact vector search を行います（embedding model は使いません）。子 process の終了を確認できない場合、一時 DB を削除せず場所を報告します。結果は単一 local filesystem / LanceDB 0.30.2 / 単一 writer の制御観測であり、service/MCP reader、二重 writer、他 filesystem、OS crash / 電源断には一般化できません。

`search-docs-worker-periodic-retention.py` は別の新規 disposable DB で、実 `SearchDocsWorker(read_only=True).search()` reader process と実 writer の20-write境界を観測します。初回の `add_sections()` から既定610秒以上待ってから、実 `add_sections()` を20回目まで進め、既存 `_maybe_optimize()` の10分 cleanup を周期経路から呼びます。reader の全期間および cleanup 後観測窓の成功・失敗数、version 一覧、cleanup call 内の file hash 差分、Python 呼出し区間の重なりを記録します。既定は `checkout(version)` で snapshot を固定する経路です。通常の5秒 `read_consistency_interval` を持つ worker reader を調べる場合は、fresh DB で次を一度実行します。

```sh
ISSUE183_PIN_READER=0 ISSUE183_QUERY_POLL_SECONDS=0.05 \
  packages/db-engine/.venv/bin/python prompts/tasks/183-recovery-control/search-docs-worker-periodic-retention.py
```

この no-checkout 経路では固定 snapshot を使わず、read-only worker の通常の consistency refresh を残します。短時間の harness smoke check では `ISSUE183_MINIMUM_SEED_VERSION_AGE_SECONDS=2` を使えます。既定の610秒以外での実行は10分 retention の結果として扱いません。直近の no-checkout 長時間 run は全期間の成功数のみ保存し、cleanup 後観測窓の内訳は未保存でした。追加した phase 別カウンタは短時間 smoke でのみ確認済みで、10分試験では未実測です。version pruning と file 数・hash の差分は別の観測として記録します。embedding は fixture vector で代替します。いずれの経路も `DBEngine` 経由のMCP/HTTP実サービス、実 embedding provider、native API 内の正確な同時実行、複数 writer、他 filesystem / host、OS crash / 電源断の安全性を証明しません。子 process 終了を確認できない場合は一時 DB を残します。

`http-shutdown-unconfirmed.mjs` は実 HTTP server / DBEngine / CLI stop を disposable project で起動し、writer 前の strict 診断を一時コピーの `strict-diagnostic.js` 内で pause させます。実 CLI process 内の `fetch` response を記録するため、server route を改変せず実際の status / headers / body を観測します。加えて read-only `DBEngine` で heartbeat row を前後に読み、server log の claim readback と `WATCHING` 行を確認します。shutdown 直後の診断 process group と、その後の短い継続観測を分けて記録します。Loopback bind が制限される環境では、承認された sandbox 外で実行してください。macOS で `kill(-PGID, 0)` が `EPERM` を返した場合は `ps` から同じ process group の有無を確認し、消失を確認できなければ一時 DB を残します。この試験は signal 送信の EPERM 注入ではありません。

## 試験範囲と限界

- `lock-control.mjs`: 現行 lock の一時複製を使い、gate / users / exclusive / incomplete 作成点で SIGKILL。別 process の shared/exclusive 競合を20回実施します。さらに、shared registration 完了後に owner process を SIGKILL し、残った entry が exclusive maintenance を拒否する一方、同じ identity の shared process は参加できること、別 identity は拒否されること、自動回収されないことを確認します。
- `manual-registration-removal.mjs`: 現行 lock source を一時 module に transpile し、専用 project の identity と管理領域を確認します。project-root symlink alias が同じ canonical identity になること、process owner の情報が登録にないこと、`gate` が存在しても直接の registration 削除は実行できること、その間 lock API の exclusive 取得は拒否されることを使い捨て fixture で確認します。さらに identity 欠落 / 不一致、`exclusive` / `incomplete` 残存時の API 拒否と、通常 exclusive が `incomplete` を残したまま取得できる現行挙動を確認します。実 DB・既存管理領域・子プロセスは使わず、人間による停止確認や新規起動抑止も実証しません。
- `recreate-recovery.mjs`: 実 LanceDB を使い、identity、各必須 table、`index_requests.status` index の作成完了直後に SIGKILL する matrix を作ります。各 DB の table 構成、strict 診断の成否、診断前後の tree hash を確認した後、`sections` 作成後の DB で `index recreate` と backup restore の条件を試します。現在の source がない場合に index tree が変わらず拒否されること、source が戻れば全再構築できること、known-good backup の復元後も `incomplete` が shared registration を止めることを確認します。Embedding endpoint は loopback fake で、固定ベクトルを返し、実モデル推論を行いません。
- `recreate-recovery.mjs` の recovery fixture は、使い捨て project に `source.md` と LanceDB を作り、`sections` table 作成完了後に SIGKILL します。別の fixture child が `exclusive` と `incomplete` を作ってから SIGKILL された後、`users` が空であることを確認し、この fixture の `exclusive` directory だけを手動削除します。再構築試験では source を一時削除して preflight 拒否・index hash 不変を確認し、source を戻して全再構築します。backup 試験では正常完了した同一 fixture の `index` と `documents` をコピーして backup にし、partial DB と incomplete を作り、source を削除して recreate を拒否させます。その後、fixture の partial `index` と `documents` を削除し、known-good backup の2 directory をコピーで戻します。strict diagnosis は通りますが `incomplete` は残り、shared registration は拒否されます。これは fixture 上で明示的に行った手順であり、製品の stale lock 回収や backup restore 完了手順ではありません。
- `scalar-index-failure.py`: 必須 table がある DB で1つの index 作成例外を注入し、残る index 作成・strict 診断・filter 結果・論理行 hash・次回再試行を確認します。DB worker 内の直接呼び出しなので TypeScript service の writer 開始や本番データ規模は対象外です。
- `writer-stop-unconfirmed.mjs`: 実 MCP service / DBEngine を起動し、writer 前診断の停止を一時 bundle 内の hook で失敗させます。診断 process group の signal-0 存在確認は通し、SIGTERM 送信だけが EPERM になるよう注入します。子が生存したまま親へ SIGTERM を送り、shutdown 後の registration・exclusive・writer 起動を観測します。EPERM は harness の fault injection であり、OS 権限や実運用の process ownership 条件を再現したものではありません。
- `http-shutdown-unconfirmed.mjs`: HTTP server と CLI stop を実際に動かし、diagnostic Python worker が pause 中に `/shutdown` を処理させます。実 HTTP status/body、親 exit、CLI 成功報告、PID file、diagnostic process group の即時状態と短時間後の状態、heartbeat claim、`WATCHING` log、shared registration、exclusive 取得結果を記録します。pause worker へ `/shutdown` route が signal を送る状況は作りません。
- `process-tree.test.ts`: disposable process group に signal-0 / SIGTERM 送信時の EPERM を別々に注入し、停止未確認の rejection と shared registration が exclusive を止めることを確認します。通常 config は embedding server 用 global setup を起動するため、`vitest.config.maintenance.ts` を指定します。
- `parallel-mcp-startup.test.ts`: 同一 project の5 MCP process を同時起動し、shared 利用中の exclusive が拒否されること、別の起動途中 process を SIGKILL した後も既存利用者を残したまま同一 identity で再接続できることを確認します。SIGKILL 時点は external fake embedding endpoint の health probe 中で、local embedding child / writer の停止未確認を試していません。`worker.enabled` と `watcher.enabled` は無効です。
- `writer-heartbeat-integration.test.ts` の上記単独 case: disposable LanceDB と fake embedding endpoint で別 process の DBEngine worker が接続中のまま heartbeat lease を期限切れにし、新 Watcher が claim / `WATCHING` に進む既存挙動を確認します。旧 process は継続 heartbeat / indexing を行わず、二重の active writer を試すものではありません。sandbox の loopback 制限時は同じ許可済み sandbox 外の実行環境が必要です。
- `embedding-identity-mismatch-cleanup.mjs`: 実 MCP / DBEngine / `MaintenanceLock` を disposable project で起動します。実際の local embedding executable だけを固定 `/health`・`/ready` 応答の test child に置き換え、DB 側に別の embedding identity を用意します。child の SIGTERM 送信を fixture PID に限って EPERM にする fault injection の後、identity mismatch、DBEngine worker の停止、shared users の解放、child が HTTP 応答を続ける状態、exclusive 取得を個別に観測します。MCP の `/tmp/mcp-server-debug.log` append は harness preload で捕捉し、一時 root 内の専用ログへだけ書きます。専用 redirect log を確認し、共有ログには書き込みません。child の DB path 引数と open file も照合します。maintenance operation 自体は実行せず、対象 child の PID / process group を確認できた場合だけ cleanup します。macOS の signal-0 が `EPERM` の場合は `ps` で同一 group を確認し、状態が確定できなければ root を保持します。embedding model の実 process / 推論や実運用の OS 権限エラーを再現する試験ではありません。
- `heartbeat-stale-writer-write.mjs`: disposable LanceDB を二つの実 `DBEngine` process で開き、旧側が一度記録した heartbeat の lease を3秒に短縮して自然失効させます。新 `WatcherProcess` が `WATCHING` になった後、旧側の接続を保ったまま `createIndexRequest` を1回だけ順次実行し、新規 read-only DBEngine で保存を確認します。二つ目の稼働 Watcher、連続書込み、同時 native commit は作りません。この結果は heartbeat が個別 DBEngine write を fence しないことを示すもので、二重 writer 時の LanceDB / indexing safety を証明しません。

`writer-stop-unconfirmed.mjs` は `shutdownFailureReported` と `selectedShutdownDirectionObserved` も出力し、停止未確認時に親終了・共有登録保持を選ぶ operator 方向と現行挙動を照合します。`embedding-identity-mismatch-cleanup.mjs` は別途、startup identity mismatch 中の local embedding test child 停止失敗、registration 解放、exclusive 取得を測ります。親終了後の child 再利用はどちらも試していません。観測結果は仕様の実装承認を意味しません。

inq-11 の確認では、同一 identity の stale registration、5 MCP 並列・再接続、停止失敗を注入した identity mismatch 起動、期限切れ heartbeat takeover と takeover 後の単発旧 DBEngine write を組み合わせます。これにより shared admission / maintenance exclusion / lease takeover と startup cleanup の境界を個別に観測しますが、停止未確認 child を伴う実 embedding runtime の再起動や、二つの active Watcher が同時に native write する場合の safety は証明しません。strict diagnosis は maintenance registration と child owner を調べません。

この harness が扱うのは単一 host のローカル一時 filesystem と、identity/table/index の各操作が完了した境界での SIGKILL / fault injection です。LanceDB 0.30.2 の Python `create_scalar_index()` は Rust 側の async `create_index()` を待つ wrapper で、公開 Python API に native operation の内部 pause / progress hook はありません。時間を見計らって kill する方式では、API 呼出し前・処理中・完了後のどこで停止したかを決定的に識別できず、安全な crash-matrix 試験とはみなしません。native API 内部の停止を再現するには disposable DB 上で使える専用 failpoint が必要ですが、現状その機構はなく、OS crash・電源断、network/shared filesystem、multi-host、Windows の保証にも一般化できません。backup restore 後に残る maintenance marker をどう解除するかは未承認の製品仕様であり、この試験は marker を消しません。

## inq-12: 起動失敗 rollback の停止未確認

operator は、MCP / HTTP の起動失敗時に、その起動試行が開始した child の停止を確認できなければ、親 process は失敗終了し shared registration を保持する方向を選びました。inq-10 の「service-owned local embedding child に自動 SIGKILL しない」、inq-11 の同一 lock identity 通常起動許可も併せて扱います。registration の保持は同一 identity の shared 起動を止める保証ではなく、stale 判定・回収にも使いません。新 lock、復旧手順、通知方式、製品実装は未承認です。

実装前の試験対象は MCP の初回 `createService()`、MCP `init` 後の `refreshServiceState()`、HTTP server の直接起動と起動中 SIGINT/SIGTERM、HTTP の非同期 `WatcherProcess.start()` failure、CLI daemon の readiness timeout、CLI `server restart` とします。child stop 成功時は通常 rollback、停止未確認時は終了コード非0・shared entry 保持・exclusive maintenance 拒否を照合します。同一 identity shared 起動は inq-11 どおり許可されることを別の観測として扱い、child が stale / 安全と断定しません。local embedding / DBEngine / strict diagnostic worker ごとに専用 fixture child を使い、実利用 DB は使いません。

現状は `embedding-identity-mismatch-cleanup.mjs` で、MCP の identity mismatch 中に child の SIGTERM 失敗を注入すると、shared entry が解放され親 MCP が残る経路を確認済みです。HTTP の `server-startup-cleanup.test.ts` は stop error 時の registration 保持を mock で確認しますが、実 child・親 process exit・起動中 signal は確認しません。現行実装の read-through と次に必要な試験条件は `prompts/tasks/183.maintenance-recovery-investigation.v1.md` の inq-12 記録を参照してください。ここに記した受け入れ方向は設計記録であり、現行製品挙動を変更した結果ではありません。

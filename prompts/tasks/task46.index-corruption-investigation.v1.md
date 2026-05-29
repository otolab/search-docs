# task46: LanceDBインデックス破損調査・修正

## 状況

ホスト側とDockerコンテナの両方でsearch-docsを動かしている環境で、LanceDBのBITMAPインデックスファイルが見つからないエラーが発生。

### エラー内容

```
LanceError(IO): Object at location .../.search-docs/index/index_requests.lance/_indices/<uuid>/bitmap_page_lookup.lance not found: No such file or directory (os error 2)
```

- `findIndexRequests()`実行時（IndexWorkerのperiodic processing中）
- ホスト側（writer）のログで確認
- Docker側でもインデックス破損エラーが出ている
- **両方で動いている場合に壊れる**

## 原因

### 確定: `cleanup_older_than=timedelta(days=0)` による即時ファイル削除

`worker.py:547` の `_maybe_optimize()`:
```python
table.optimize(cleanup_older_than=timedelta(days=0))
```

- 20回の書き込みごとに実行
- **古いバージョンのファイルを即座に削除**（データ + インデックスファイル）
- 他プロセスが古いバージョンのインデックスを参照中 → File not found

### LanceDB公式見解

- `cleanup_older_than=0` は進行中のトランザクション参照ファイルも削除する（GitHub Issue #2470）
- **最小推奨値: 10分**（GitHub Discussion #5036）
- 安全な計算式: `read_consistency_interval × 2 + 典型的な書き込み時間` 以上

### 現場の証拠

| 事実 | 説明 |
|------|------|
| 504個の空UUIDディレクトリ | optimize()がインデックスファイルを削除、ディレクトリだけ残った |
| _versionsが2個だけ | 古いバージョンが即座にpruneされている |
| 両方動いている時だけ壊れる | プロセスAがprune → プロセスBが古いバージョンのファイルを参照 → File not found |

### 経緯

task27（Issue #46）で「`cleanup_older_than=timedelta(days=0)` で古いインデックスを即座に削除するか検討」と記録されていたが、`days=0` のまま実装された。

## 修正

`worker.py:541` に定数を追加し、`_maybe_optimize()` で使用:

```python
CLEANUP_OLDER_THAN = timedelta(minutes=10)

def _maybe_optimize(self, table, table_name: str) -> None:
    ...
    table.optimize(cleanup_older_than=self.CLEANUP_OLDER_THAN)
```

- 変更箇所: 1箇所（`_maybe_optimize`メソッドのみ）
- 全7箇所の呼び出し元は変更不要（メソッド経由）

# Task 39: Docker MCP Read-Only + Writer/Watcher 設計

## 背景

複数の Claude Code インスタンスが同一プロジェクトに対して Docker MCP コンテナを起動する際、
各コンテナが独自の search-docs server + worker を起動し、同一 DB への同時書き込みリスクがある。

## Phase 1-2: Read-Only サーバモード (完了)

### コミット
- `2f1d095` feat: Read-only サーバモード追加（複数MCPインスタンス対応）

### 変更内容
| ファイル | 変更 |
|---------|------|
| `worker.py` | `--read-only` フラグ、`read_consistency_interval=5s` |
| `index.ts` (db-engine) | `readOnly` オプション → Python に伝搬 |
| `config.ts` (types) | `server.readOnly` 設定追加 |
| `server.ts` (bin) | read-only 時の PID/watcher/worker 制御 |
| `search-docs-server.ts` | read-only 時の StartupSync スキップ |
| `entrypoint.sh` | `READ_ONLY=true` 時 embedding server 省略 |

### アーキテクチャ
```
[Writer/Watcher] (1つ、ホスト or 別コンテナ)
  プロジェクトdir 監視 → embedding → .search-docs/ に書き込み

[MCP A] (read-only) ← Claude Code A
  .search-docs/ をマウント (read_consistency_interval=5s)

[MCP B] (read-only) ← Claude Code B
  同じ .search-docs/ をマウント
```

### 技術的根拠
- **LanceDB MVCC**: 複数リーダー + 単一ライターは安全
- **楽観的並行制御**: 複数ライターでもデータ破損しない（一方がリトライ/失敗）
- **Docker for Mac VirtioFS**: flock不可だがLanceDBはatomic commitで問題なし

## Phase 3: Writer/Watcher 設計 (これから)

### 課題
- read-only MCP コンテナはインデックス更新ができない
- プロジェクトのファイル変更を検知し、インデックスを更新する Writer が必要
- Writer の起動・管理・調停をどうするか

### 検討事項

#### Writer の起動方式
1. **ホスト側で手動起動** (最もシンプル)
   - `search-docs server start` をホストで実行
   - MCP コンテナは全て `READ_ONLY=true`
   - 利点: 明確な責任分担、既存コマンドで動作
   - 欠点: ユーザが手動管理する必要

2. **MCP コンテナ内で自動 watchdog**
   - heartbeat ファイルで Writer の生存確認
   - Writer がいなければ自分が Writer に昇格
   - 利点: 自動調停、ユーザ操作不要
   - 欠点: 複雑、Docker内からホストのファイル監視が必要

3. **専用 Writer コンテナ** (docker-compose)
   - Docker MCP Toolkit は docker-compose 非サポート
   - ただし手動で別コンテナとして起動は可能
   - 利点: 分離が明確
   - 欠点: ユーザのセットアップ負担

#### Heartbeat/Watchdog パターン (案2の詳細)
```
.search-docs/watcher.heartbeat  (JSON)
  { "pid": 12345, "host": "container-abc", "updatedAt": "2026-04-17T..." }
```
- Writer が 10秒ごとに heartbeat 更新
- 30秒以上更新なし → stale 判定 → 別インスタンスが Writer に昇格
- 二重起動しても LanceDB は壊れない（冗長処理のみ）

### 次のステップ
- [ ] Writer の起動方式を決定
- [ ] Writer/Watcher の実装
- [ ] Docker MCP コンテナとの統合テスト

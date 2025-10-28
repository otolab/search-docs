# CLIツール実装計画

**作成日**: 2025-10-28
**対象**: packages/cli
**前提**: Phase 3.1 (client) 完了

## 目的

search-docsサーバの操作とドキュメント検索を行うコマンドラインツールを実装する。

## 概要

- **パッケージ名**: `@search-docs/cli`
- **実行ファイル**: `search-docs` コマンド
- **依存関係**: `@search-docs/client`, `@search-docs/types`
- **技術スタック**: TypeScript, commander.js (CLI framework)

## コマンド構成

### 1. server コマンド

サーバの起動・停止・ステータス確認

```bash
search-docs server start [options]    # サーバ起動
search-docs server stop                # サーバ停止
search-docs server status              # サーバステータス確認
search-docs server restart             # サーバ再起動
```

**オプション**:
- `--config <path>` - 設定ファイルのパス（デフォルト: .search-docs.json）
- `--port <port>` - ポート番号（デフォルト: 24280）
- `--daemon, -d` - バックグラウンドで起動
- `--log <path>` - ログファイルのパス

**実装方針**:
- `packages/server/bin/server.ts` を子プロセスとして起動
- PIDファイル管理（`.search-docs/server.pid`）
- デーモン化: バックグラウンドプロセスとして実行

### 2. search コマンド

ドキュメント検索

```bash
search-docs search <query> [options]
```

**オプション**:
- `--limit <n>` - 最大結果数（デフォルト: 10）
- `--depth <depths...>` - 深度フィルタ（例: --depth 0 1）
- `--format <format>` - 出力形式（text, json, table）（デフォルト: table）
- `--clean-only` - Dirtyセクションを除外
- `--server <url>` - サーバURL（デフォルト: http://localhost:24280）

**出力例**:
```
検索結果: 5件（クエリ: "TypeScript 型定義"）

┌─────┬────────┬─────────────────────────────┬──────────────────────┐
│ No. │ Score  │ Heading                     │ Path                 │
├─────┼────────┼─────────────────────────────┼──────────────────────┤
│ 1   │ 0.95   │ TypeScript型定義            │ docs/types.md        │
│ 2   │ 0.87   │ 型システム                  │ docs/architecture.md │
│ 3   │ 0.82   │ インターフェイス定義        │ docs/api.md          │
└─────┴────────┴─────────────────────────────┴──────────────────────┘
```

### 3. index コマンド

インデックス管理

```bash
search-docs index rebuild [paths...]   # インデックス再構築
search-docs index status                # インデックスステータス確認
search-docs index clean                 # Dirtyセクションをクリーン
```

**オプション**:
- `--force` - 強制的に再インデックス
- `--server <url>` - サーバURL

**実装方針**:
- `client.rebuildIndex()` を呼び出し
- 進捗表示（処理中のファイル数、セクション数）
- エラーハンドリング

### 4. config コマンド

設定管理

```bash
search-docs config init [options]       # 設定ファイル初期化
search-docs config validate             # 設定ファイル検証
search-docs config show                 # 設定内容表示
```

**オプション（init）**:
- `--interactive, -i` - 対話的に設定を作成
- `--force, -f` - 既存ファイルを上書き

**実装方針**:
- デフォルト設定ファイル（`.search-docs.json`）を生成
- JSON Schema バリデーション
- 対話的設定: inquirer.js 使用

## パッケージ構成

```
packages/cli/
├── bin/
│   └── search-docs.ts        # エントリポイント（#!/usr/bin/env node）
├── src/
│   ├── commands/
│   │   ├── server.ts         # server コマンド
│   │   ├── search.ts         # search コマンド
│   │   ├── index.ts          # index コマンド
│   │   └── config.ts         # config コマンド
│   ├── utils/
│   │   ├── output.ts         # 出力フォーマット（table, json）
│   │   ├── process.ts        # プロセス管理（PID、デーモン化）
│   │   └── config.ts         # 設定ファイル操作
│   └── index.ts              # CLI設定（commander.js）
├── __tests__/
│   ├── server.test.ts
│   ├── search.test.ts
│   ├── index.test.ts
│   └── config.test.ts
├── package.json
└── tsconfig.json
```

## 依存関係

### 必須

- `@search-docs/client` - サーバ通信
- `@search-docs/types` - 型定義
- `commander` - CLIフレームワーク
- `chalk` - カラー出力
- `cli-table3` - テーブル出力

### オプション（対話的UI）

- `inquirer` - 対話的プロンプト（config init用）
- `ora` - スピナー表示（処理中表示）

## 実装ステップ

### Phase 1: 基本構造

1. ✅ パッケージ設定（package.json, tsconfig.json）
2. ✅ bin/search-docs.ts エントリポイント作成
3. ✅ commander.js でCLI基本構造
4. ✅ ビルド確認

### Phase 2: search コマンド

1. ✅ search コマンド実装
2. ✅ 出力フォーマット（table, json, text）
3. ✅ テスト作成
4. ✅ ビルド確認

### Phase 3: server コマンド

1. ✅ server start 実装（プロセス起動、PID管理）
2. ✅ server stop 実装（PIDファイルからプロセス停止）
3. ✅ server status 実装（プロセス確認、healthCheck）
4. ✅ デーモン化対応（オプション）
5. ✅ テスト作成
6. ✅ ビルド確認

### Phase 4: index コマンド

1. ✅ index rebuild 実装
2. ✅ index status 実装
3. ✅ index clean 実装
4. ✅ テスト作成
5. ✅ ビルド確認

### Phase 5: config コマンド

1. ✅ config init 実装
2. ✅ config validate 実装
3. ✅ config show 実装
4. ✅ 対話的UI（オプション）
5. ✅ テスト作成
6. ✅ ビルド確認

### Phase 6: 統合とドキュメント

1. ✅ 全コマンド統合テスト
2. ✅ ヘルプテキスト整備
3. ✅ README作成
4. ✅ 使用例ドキュメント
5. ✅ 型チェック、lint

## テスト計画

### ユニットテスト

- 各コマンドの基本動作
- 出力フォーマット
- エラーハンドリング
- 設定ファイル操作

### 統合テスト

- サーバ起動→検索→停止の一連の流れ
- インデックス再構築
- 設定ファイル初期化→検証

### E2Eテスト（手動）

- 実際のプロジェクトでのCLI実行
- エラーケースの確認

## 技術的考慮事項

### プロセス管理

**課題**: Node.jsプロセスのデーモン化

**選択肢**:
1. child_process.spawn with detached: true
2. pm2などの外部ツール利用
3. systemdサービス（Linux）

**採用**: child_process.spawn (シンプル、依存なし)

### PIDファイル管理

**場所**: `.search-docs/server.pid`

**内容**:
```json
{
  "pid": 12345,
  "startedAt": "2025-10-28T15:00:00Z",
  "port": 24280,
  "configPath": ".search-docs.json"
}
```

### 出力フォーマット

**table形式**: cli-table3
**json形式**: JSON.stringify
**text形式**: シンプルなテキスト出力

### エラーハンドリング

- サーバ未起動時のエラーメッセージ
- ネットワークエラー
- 設定ファイルエラー
- 終了コード（0: 成功、1: エラー）

## 使用例

### 基本的な使い方

```bash
# 設定ファイル初期化
search-docs config init

# サーバ起動
search-docs server start --daemon

# 検索
search-docs search "TypeScript 型定義" --limit 5

# インデックス再構築
search-docs index rebuild

# サーバ停止
search-docs server stop
```

### 高度な使い方

```bash
# 特定の深度で検索
search-docs search "API" --depth 1 2

# JSON形式で出力
search-docs search "test" --format json

# 特定のファイルのみ再インデックス
search-docs index rebuild docs/api.md docs/types.md

# カスタム設定ファイル
search-docs server start --config custom-config.json

# リモートサーバに接続
search-docs search "test" --server http://remote-server:8080
```

## package.json 設定

```json
{
  "name": "@search-docs/cli",
  "version": "0.1.0",
  "description": "search-docs コマンドラインツール",
  "bin": {
    "search-docs": "./dist/bin/search-docs.js"
  },
  "scripts": {
    "build": "tsc --build",
    "dev": "tsx bin/search-docs.ts",
    "test": "vitest"
  },
  "dependencies": {
    "@search-docs/client": "workspace:*",
    "@search-docs/types": "workspace:*",
    "commander": "^11.0.0",
    "chalk": "^5.0.0",
    "cli-table3": "^0.6.0",
    "ora": "^7.0.0"
  },
  "devDependencies": {
    "inquirer": "^9.0.0"
  }
}
```

## 次のステップ

1. Phase 1から順次実装
2. 各Phaseでビルド・テスト確認
3. コミット（Phase単位）
4. 最終的にドキュメント作成

## リスク管理

### 技術的リスク

1. **プロセス管理の複雑さ**: デーモン化、PID管理
   - 対策: シンプルな実装から開始、必要に応じて拡張

2. **クロスプラットフォーム対応**: Windows/Mac/Linux
   - 対策: Node.js標準APIを使用、プラットフォーム固有機能は最小限

3. **サーバとの通信エラー**: タイムアウト、接続エラー
   - 対策: 適切なエラーメッセージ、リトライロジック

### 対応策

- 小さく実装して動作確認
- 各コマンドを独立して実装
- テストを必ず作成

---

**作成日**: 2025-10-28
**最終更新**: 2025-10-28
**状態**: 計画完了、実装開始待ち

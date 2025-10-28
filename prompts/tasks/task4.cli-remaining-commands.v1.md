# CLI残りのコマンド実装計画

**作成日**: 2025-10-28
**タスク番号**: task4
**前提**: Phase 1-2 (基本構造、searchコマンド) 完了

## 目的

search-docs CLIツールの残りのコマンド（server, index, config）を実装する。

## 現状

### 実装済み
- ✅ Phase 1: 基本構造（commander.js、エントリポイント）
- ✅ Phase 2: searchコマンド（検索機能、出力フォーマット）
- ✅ E2Eテスト（サーバ起動・検索の統合テスト）
- ✅ テスト出力抑制（TEST_VERBOSE環境変数）

### 未実装
- ❌ Phase 3: serverコマンド（start, stop, status, restart）
- ❌ Phase 4: indexコマンド（rebuild, status, clean）
- ❌ Phase 5: configコマンド（init, validate, show）

### 現在のファイル構成

```
packages/cli/
├── bin/
│   └── search-docs.ts          # エントリポイント
├── src/
│   ├── index.ts                # CLI定義（未実装コマンド含む）
│   ├── commands/
│   │   └── search.ts           # searchコマンド実装
│   └── utils/
│       └── output.ts           # 出力フォーマット
├── __tests__/
│   └── e2e.test.ts             # E2Eテスト
└── vitest.config.ts            # テスト設定
```

## 実装計画

### Phase 3: serverコマンド

プロセス管理とサーバ制御を実装する。

#### 3.1 server start

**機能**:
- サーバプロセスを起動（デーモン or フォアグラウンド）
- PIDファイル管理（`.search-docs/server.pid`）
- 設定ファイル読み込み
- ポート指定・ログファイル対応

**実装ファイル**:
- `src/commands/server/start.ts`
- `src/utils/process.ts` (プロセス管理ユーティリティ)
- `src/utils/pid.ts` (PIDファイル管理)

**技術要素**:
```typescript
import { spawn } from 'child_process';

// デーモン起動
const serverProcess = spawn('node', [serverScript], {
  detached: true,      // 親プロセスから切り離し
  stdio: 'ignore',     // 標準入出力を無視
  env: { SEARCH_DOCS_CONFIG: configPath },
});

// PIDファイル保存
await savePidFile({
  pid: serverProcess.pid,
  startedAt: new Date().toISOString(),
  port: config.server.port,
  configPath: configPath,
});

serverProcess.unref();  // 親プロセス終了時に子も終了させない
```

**オプション**:
- `--config <path>`: 設定ファイルパス（デフォルト: `.search-docs.json`）
- `--port <port>`: ポート番号（デフォルト: 24280）
- `--daemon, -d`: バックグラウンド起動
- `--log <path>`: ログファイルパス

**エラーハンドリング**:
- 既にサーバが起動している場合
- 設定ファイルが見つからない場合
- ポートが使用中の場合

#### 3.2 server stop

**機能**:
- PIDファイルからプロセスIDを読み込み
- SIGTERMシグナルで停止
- 停止確認とタイムアウト処理
- PIDファイル削除

**実装ファイル**:
- `src/commands/server/stop.ts`

**技術要素**:
```typescript
const pidInfo = await readPidFile();
process.kill(pidInfo.pid, 'SIGTERM');

// 停止確認（最大5秒待機）
await waitForProcessExit(pidInfo.pid, 5000);

// PIDファイル削除
await deletePidFile();
```

**エラーハンドリング**:
- PIDファイルが存在しない場合
- プロセスが既に停止している場合
- 停止タイムアウト（SIGKILL）

#### 3.3 server status

**機能**:
- PIDファイル確認
- プロセス生存確認
- サーバヘルスチェック（/health）
- サーバステータス取得（/rpc → getStatus）

**実装ファイル**:
- `src/commands/server/status.ts`

**出力例**:
```
Server Status:
  Status: Running
  PID: 12345
  Started: 2025-10-28 15:00:00
  Port: 24280
  Config: /path/to/.search-docs.json

Index Status:
  Total Documents: 42
  Total Sections: 256
  Dirty Count: 3

Worker Status:
  Running: Yes
  Processing: 1
  Queue: 2
```

**エラーハンドリング**:
- サーバが起動していない場合
- ヘルスチェック失敗

#### 3.4 server restart

**機能**:
- server stop + server start の組み合わせ

**実装ファイル**:
- `src/commands/server/restart.ts`

### Phase 4: indexコマンド

インデックス管理機能を実装する。

#### 4.1 index rebuild

**機能**:
- サーバのrebuildIndex APIを呼び出し
- 進捗表示（処理中のファイル数、セクション数）
- 指定パスのみ再構築（オプション）

**実装ファイル**:
- `src/commands/index/rebuild.ts`

**技術要素**:
```typescript
const client = new SearchDocsClient({ baseUrl: serverUrl });
const response = await client.rebuildIndex({ paths });

console.log(`Rebuilt: ${response.documentsProcessed} documents`);
console.log(`Created: ${response.sectionsCreated} sections`);
```

**オプション**:
- `--force`: Dirtyでなくても再インデックス
- `--server <url>`: サーバURL

**引数**:
- `[paths...]`: 再構築するファイルパス（省略時は全体）

#### 4.2 index status

**機能**:
- サーバのgetStatus APIを呼び出し
- インデックス統計を表示

**実装ファイル**:
- `src/commands/index/status.ts`

**出力例**:
```
Index Status:
  Total Documents: 42
  Total Sections: 256
  Dirty Sections: 3

Recent Activity:
  Last Indexed: 2025-10-28 15:00:00
  Last Search: 2025-10-28 15:30:00
```

#### 4.3 index clean

**機能**:
- Dirtyセクションの強制クリーン
- 再インデックスの実行

**実装ファイル**:
- `src/commands/index/clean.ts`

**実装方針**:
- `rebuildIndex` APIで全体を再構築
- または特定のDirtyドキュメントのみ再構築

### Phase 5: configコマンド

設定管理機能を実装する。

#### 5.1 config init

**機能**:
- デフォルト設定ファイル生成（`.search-docs.json`）
- 対話的な設定作成（オプション）
- 既存ファイルの上書き確認

**実装ファイル**:
- `src/commands/config/init.ts`
- `src/utils/config.ts` (設定ファイル操作)

**デフォルト設定**:
```json
{
  "version": "1.0",
  "project": {
    "name": "my-project",
    "root": "."
  },
  "files": {
    "include": ["**/*.md"],
    "exclude": ["**/node_modules/**", "**/.git/**"],
    "ignoreGitignore": true
  },
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m"
  },
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  },
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  },
  "storage": {
    "documentsPath": ".search-docs/documents",
    "indexPath": ".search-docs/index",
    "cachePath": ".search-docs/cache"
  },
  "watcher": {
    "enabled": true,
    "debounce": 1000,
    "ignored": ["**/node_modules/**", "**/.git/**"]
  },
  "worker": {
    "enabled": true,
    "interval": 5000,
    "maxConcurrent": 3
  }
}
```

**オプション**:
- `--interactive, -i`: 対話的に設定を作成（後回し可）
- `--force, -f`: 既存ファイルを上書き

#### 5.2 config validate

**機能**:
- 設定ファイルのバリデーション
- JSON構文チェック
- スキーマ検証（ConfigLoader.validateを利用）

**実装ファイル**:
- `src/commands/config/validate.ts`

**出力例**:
```
✓ Configuration is valid
  - Project: my-project
  - Root: /path/to/project
  - Include patterns: 1
  - Server port: 24280
```

**エラー出力例**:
```
✗ Configuration is invalid:
  - server.port must be a number
  - files.include must be an array
```

#### 5.3 config show

**機能**:
- 設定ファイルの内容を表示
- JSON形式で出力
- 設定ファイルパス表示

**実装ファイル**:
- `src/commands/config/show.ts`

**出力例**:
```
Configuration: /path/to/.search-docs.json

{
  "version": "1.0",
  "project": {
    "name": "my-project",
    ...
  }
}
```

## 実装順序

### ステップ1: ユーティリティ実装（共通）

優先度: 高

1. `src/utils/process.ts` - プロセス管理
   - サーバプロセス起動
   - プロセス停止
   - プロセス生存確認
2. `src/utils/pid.ts` - PIDファイル管理
   - PIDファイル作成・読み込み・削除
   - PIDファイル形式定義
3. `src/utils/config.ts` - 設定ファイル操作
   - デフォルト設定生成
   - 設定ファイル読み書き

### ステップ2: serverコマンド実装

優先度: 高（最も重要な機能）

1. server start（デーモン起動なし版）
2. server stop
3. server status
4. server start（デーモン起動対応）
5. server restart
6. テスト作成

### ステップ3: configコマンド実装

優先度: 中（serverコマンドで必要）

1. config init
2. config validate
3. config show
4. テスト作成

### ステップ4: indexコマンド実装

優先度: 中

1. index status
2. index rebuild
3. index clean
4. テスト作成

### ステップ5: 統合・ドキュメント

優先度: 低

1. 全コマンドの動作確認
2. ヘルプテキスト整備
3. README更新
4. 使用例追加

## 技術的考慮事項

### プロセス管理

**デーモン化の方法**:
```typescript
// デーモン起動
const child = spawn('node', [serverScript], {
  detached: true,     // 親から切り離す
  stdio: ['ignore', logFd, logFd],  // stdout/stderrをログファイルへ
});
child.unref();        // 親プロセス終了を待たない
```

**クロスプラットフォーム対応**:
- Windows: `detached`の動作が異なる
- macOS/Linux: シグナル処理に注意

### PIDファイル形式

**場所**: `.search-docs/server.pid`

**内容**:
```typescript
interface PidFileContent {
  pid: number;
  startedAt: string;  // ISO 8601
  port: number;
  configPath: string;
  logPath?: string;
}
```

### エラーハンドリング

**共通方針**:
- エラーメッセージは日本語で分かりやすく
- 終了コード: 0（成功）、1（エラー）
- スタックトレースは`--verbose`モードのみ

### テスト戦略

**ユニットテスト**:
- 各ユーティリティ関数
- PIDファイル操作
- 設定ファイル操作

**統合テスト**:
- serverコマンドの起動・停止
- indexコマンドのAPI呼び出し
- configコマンドのファイル操作

**E2Eテスト**:
- 既存のE2Eテストを拡張
- server start → search → server stop の流れ

## リスク管理

### 技術的リスク

1. **プロセス管理の複雑さ**
   - リスク: デーモン化、PID管理の実装が複雑
   - 対策: 最小限の実装から開始、段階的に機能追加

2. **クロスプラットフォーム対応**
   - リスク: Windows/Mac/Linuxで動作が異なる
   - 対策: Node.js標準APIを使用、必要に応じてプラットフォーム判定

3. **PIDファイルの競合**
   - リスク: 複数プロセスが同時に起動される
   - 対策: ファイルロック、プロセス生存確認

### 対応策

- 小さく実装して動作確認
- 各コマンドを独立して実装
- テストを必ず作成
- エラーハンドリングを丁寧に

## 依存関係の追加

現状で必要な依存関係は揃っている：
- `commander`: CLIフレームワーク
- `@search-docs/client`: サーバ通信
- `@search-docs/types`: 型定義

**オプション（後で検討）**:
- `chalk`: カラー出力（status表示を見やすく）
- `ora`: スピナー表示（処理中表示）
- `inquirer`: 対話的UI（config init --interactive）

## 完了条件

### 各Phase

- [ ] Phase 3: serverコマンド
  - [ ] server start が動作する
  - [ ] server stop が動作する
  - [ ] server status が動作する
  - [ ] server restart が動作する
  - [ ] ユニットテスト通過

- [ ] Phase 4: indexコマンド
  - [ ] index rebuild が動作する
  - [ ] index status が動作する
  - [ ] index clean が動作する
  - [ ] ユニットテスト通過

- [ ] Phase 5: configコマンド
  - [ ] config init が動作する
  - [ ] config validate が動作する
  - [ ] config show が動作する
  - [ ] ユニットテスト通過

### 全体

- [ ] 全コマンドがビルド成功
- [ ] 全テスト通過
- [ ] 型チェック・lint通過
- [ ] E2Eテスト拡張
- [ ] README更新

## 次のステップ

1. ステップ1: ユーティリティ実装から開始
2. 小さく実装してテスト
3. コミット（機能単位）
4. Phase 3 → Phase 5 → Phase 4 の順で実装

---

**作成日**: 2025-10-28
**最終更新**: 2025-10-28
**状態**: 計画作成完了、実装開始待ち
**推定工数**: Phase 3（4-6時間）、Phase 4（2-3時間）、Phase 5（2-3時間）

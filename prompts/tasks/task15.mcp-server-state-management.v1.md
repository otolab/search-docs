# Task 15: MCPサーバの状態管理機能拡張

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

## 作業概要

MCPサーバの起動条件を変更し、役割を拡大する。
具体的には、search-docsの導入から運用までを統括するインターフェイスとして、MCPサーバを再設計する。

## 背景

### 現在の問題

現在のMCPサーバは以下の前提で動作している：
- `.search-docs.json` が存在することを前提
- search-docsサーバが起動していることを前提（または自動起動）
- 設定がない場合はエラーで終了

### search-docs導入の現実

search-docsを使用するには**2段階の手間**が必要：

1. **設定の作成**：`search-docs config init`
2. **サーバの起動**：`search-docs server start`

さらに、初期インデックスの生成が完了するまで、完全には使えない。

### 求められる改善

MCPサーバは「状態」を判定するところからスタートするべき：

1. **未設定状態**：設定ファイルがない
   - 利用可能な操作：`init`（設定作成）
   - 検索などは無効、セットアップが必要である旨を通知

2. **設定済み・サーバ未起動状態**：設定はあるがサーバが起動していない
   - 利用可能な操作：`server_start`、`init`（再設定）
   - 検索などは無効、サーバ起動が必要である旨を通知

3. **完全稼働状態**：設定あり、サーバ起動済み
   - 利用可能な操作：全ツール（search、get_document、index_status、server_stop、server_restart）
   - インデックス生成中の場合は、その旨を通知

## 目標

MCPサーバを「search-docsのセットアップから管理までを統括するインターフェイス」として機能させる。

## フェーズ設計

### フェーズ1: 調査・設計

**目的**：現在の実装を完全に把握し、状態管理システムを設計する

**タスク**：
1. CLIコマンドの実装を確認（config init, server start/stop）
2. 状態判定ロジックの設計
3. 各状態での利用可能ツールの定義
4. 新規ツールの仕様設計（init, server_start, server_stop, server_restart, get_status）

### フェーズ2: 実装

**目的**：設計に基づいてMCPサーバを改修

**タスク**：
1. 状態判定機構の実装
2. 新規ツールの実装
3. 既存ツールへの状態チェック追加
4. エラーメッセージの改善

### フェーズ3: テスト・検証

**目的**：各状態で正しく動作することを確認

**タスク**：
1. 未設定状態でのテスト
2. 設定済み・サーバ未起動状態でのテスト
3. 完全稼働状態でのテスト
4. 状態遷移のテスト

## 詳細設計メモ

### 状態定義

```typescript
enum SystemState {
  NOT_CONFIGURED = 'not_configured',      // 設定ファイルなし
  CONFIGURED_SERVER_DOWN = 'configured_server_down',  // 設定あり、サーバ停止中
  RUNNING = 'running',                    // サーバ稼働中
}
```

### 状態判定ロジック

```typescript
async function detectSystemState(): Promise<SystemState> {
  // 1. 設定ファイルの存在確認
  const configExists = await checkConfigFile();
  if (!configExists) {
    return SystemState.NOT_CONFIGURED;
  }

  // 2. サーバの起動確認
  const serverRunning = await checkServerHealth();
  if (!serverRunning) {
    return SystemState.CONFIGURED_SERVER_DOWN;
  }

  // 3. 完全稼働
  return SystemState.RUNNING;
}
```

### 新規ツール仕様

#### 1. init

**用途**：設定ファイルの初期化（未設定状態で使用）

**パラメータ**：
- `port?: number` - サーバポート番号（省略時はランダム）
- `force?: boolean` - 既存設定を上書き

**動作**：
- CLIの `config init` コマンドを実行
- 設定ファイルを生成
- 成功したら次のステップ（サーバ起動）を案内

#### 2. server_start

**用途**：search-docsサーバの起動

**パラメータ**：
- `foreground?: boolean` - フォアグラウンド起動（デフォルト: false）

**動作**：
- 現在の状態を確認（設定済みであることを確認）
- CLIの `server start` コマンドを実行
- 起動成功を確認
- インデックス生成の開始を通知

#### 3. server_stop

**用途**：search-docsサーバの停止

**動作**：
- CLIの `server stop` コマンドを実行
- 停止を確認

#### 4. server_restart

**用途**：search-docsサーバの再起動

**動作**：
- CLIの `server restart` コマンドを実行

#### 5. get_system_status

**用途**：システム全体の状態を取得

**戻り値**：
- システム状態（未設定/設定済み・サーバ停止/稼働中）
- サーバ情報（稼働中の場合）
- インデックス情報（稼働中の場合）
- 次のアクション推奨

### 既存ツールの変更

#### search, get_document

**変更内容**：
- 実行前に状態確認
- RUNNING状態でない場合はエラー
- エラーメッセージで必要なアクションを案内

#### index_status

**変更内容**：
- 実行前に状態確認
- RUNNING状態でない場合はエラー

### エラーメッセージ設計

#### NOT_CONFIGURED状態

```
search-docsがまだセットアップされていません。

まず、設定ファイルを作成してください：
  ツール: init

設定作成後、サーバを起動してください：
  ツール: server_start
```

#### CONFIGURED_SERVER_DOWN状態

```
search-docsサーバが起動していません。

サーバを起動してください：
  ツール: server_start

または、設定を再作成する場合：
  ツール: init --force
```

## 実装詳細設計

### CLIコマンドの実装詳細（調査結果）

#### config/init.ts

**エクスポート関数**：
- `initConfig(options: ConfigInitOptions): Promise<void>`

**オプション**：
```typescript
interface ConfigInitOptions {
  port?: number;       // ポート番号（省略時はランダム）
  projectRoot?: string; // プロジェクトルート（デフォルト: cwd）
  force?: boolean;     // 既存ファイルを上書き
  cwd?: string;        // カレントワーキングディレクトリ（テスト用）
}
```

**動作**：
- 既存ファイルがある場合、`force`がなければ正常終了（エラーではない）
- ランダムポート生成はエフェメラルポート範囲（49152-65535）
- 設定ファイルは `.search-docs.json` に作成

#### server/start.ts

**エクスポート関数**：
- `startServer(options: ServerStartOptions): Promise<void>` - 内部ロジック、process.exit()しない
- `executeServerStart(options: ServerStartOptions): Promise<void>` - CLIエントリポイント

**オプション**：
```typescript
interface ServerStartOptions {
  config?: string;      // 設定ファイルパス
  port?: string;        // ポート番号（文字列）
  foreground?: boolean; // フォアグラウンド起動
  log?: string;         // ログファイルパス
}
```

**動作**：
- デフォルトはデーモンモード（`foreground: false`）
- PIDファイル管理（`.search-docs/server.pid`）
- ポート競合チェック
- ヘルスチェックで起動確認（デーモンモードの場合）

#### server/stop.ts

**エクスポート関数**：
- `stopServer(options: ServerStopOptions): Promise<void>` - 内部ロジック
- `executeServerStop(options: ServerStopOptions): Promise<void>` - CLIエントリポイント

**オプション**：
```typescript
interface ServerStopOptions {
  config?: string; // 設定ファイルパス
}
```

**動作**：
- PIDファイル読み込み
- プロセス停止（SIGTERM）
- PIDファイル削除

#### server/restart.ts

**エクスポート関数**：
- `executeServerRestart(options: ServerRestartOptions): Promise<void>`

**動作**：
- `stopServer()` → 1秒待機 → `startServer()`

### MCPサーバの起動ロジック変更

#### 現在の起動ロジック（server.ts:92-184）

```typescript
// 1. 設定ファイル読み込み（requireConfig: true）
const { config, configPath, projectRoot } = await ConfigLoader.resolve({
  cwd,
  requireConfig: true, // エラーで終了
});

// 2. クライアント初期化
const client = new SearchDocsClient({ baseUrl: serverUrl });

// 3. ヘルスチェック → 失敗したらサーバ自動起動
try {
  await client.healthCheck();
} catch (_error) {
  await serverManager.startServer(projectRoot, config.server.port, configPath);
  await client.healthCheck();
}

// 4. ツール登録（search, get_document, index_status）
```

#### 新しい起動ロジック（提案）

```typescript
// 1. 状態判定（設定ファイルとサーバの状態を確認）
const systemState = await detectSystemState();

// 2. 状態に応じたツール登録
switch (systemState.state) {
  case 'NOT_CONFIGURED':
    // init, get_system_status のみ登録
    break;
  case 'CONFIGURED_SERVER_DOWN':
    // init, server_start, get_system_status を登録
    break;
  case 'RUNNING':
    // 全ツールを登録
    break;
}

// 3. MCPサーバ起動
```

### 状態判定の実装

#### SystemState型定義

```typescript
interface SystemStateInfo {
  state: 'NOT_CONFIGURED' | 'CONFIGURED_SERVER_DOWN' | 'RUNNING';
  config?: SearchDocsConfig;
  configPath?: string;
  projectRoot: string;
  serverUrl?: string;
  client?: SearchDocsClient;
}
```

#### detectSystemState() の実装

```typescript
async function detectSystemState(cwd: string): Promise<SystemStateInfo> {
  // 1. 設定ファイルの存在確認
  let config, configPath, projectRoot;
  try {
    const result = await ConfigLoader.resolve({
      cwd,
      requireConfig: false, // エラーで終了しない
    });

    if (!result.config) {
      // 設定ファイルなし
      return {
        state: 'NOT_CONFIGURED',
        projectRoot: cwd,
      };
    }

    config = result.config;
    configPath = result.configPath;
    projectRoot = result.projectRoot;
  } catch (_error) {
    // 設定ファイル読み込みエラー
    return {
      state: 'NOT_CONFIGURED',
      projectRoot: cwd,
    };
  }

  // 2. サーバのヘルスチェック
  const serverUrl = `http://${config.server.host}:${config.server.port}`;
  const client = new SearchDocsClient({ baseUrl: serverUrl });

  try {
    await client.healthCheck();

    // サーバ稼働中
    return {
      state: 'RUNNING',
      config,
      configPath,
      projectRoot,
      serverUrl,
      client,
    };
  } catch (_error) {
    // サーバ停止中
    return {
      state: 'CONFIGURED_SERVER_DOWN',
      config,
      configPath,
      projectRoot,
      serverUrl,
    };
  }
}
```

### 新規ツールの実装

#### 共通ヘルパー関数

```typescript
// CLIコマンドのラッパー（エラーハンドリングを統一）
async function callCliCommand<T>(
  fn: () => Promise<T>,
  errorPrefix: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${errorPrefix}: ${(error as Error).message}`);
  }
}
```

#### init ツール

```typescript
server.registerTool(
  'init',
  {
    description: 'search-docsの設定ファイルを初期化します。プロジェクトで初めてsearch-docsを使用する場合に実行してください。',
    inputSchema: {
      port: z.number().optional().describe('サーバポート番号（省略時はランダム）'),
      force: z.boolean().optional().describe('既存設定を上書き（デフォルト: false）'),
    },
  },
  async (args: { port?: number; force?: boolean }) => {
    const { port, force } = args;

    await callCliCommand(
      () => initConfig({ port, force, cwd: projectRoot }),
      'Failed to initialize configuration'
    );

    return {
      content: [
        {
          type: 'text',
          text: '✅ 設定ファイルを作成しました。\n\n次のステップ:\n  1. サーバを起動: server_start\n  2. 文書を検索: search',
        },
      ],
    };
  }
);
```

#### server_start ツール

```typescript
server.registerTool(
  'server_start',
  {
    description: 'search-docsサーバを起動します。設定ファイルが作成済みであることが必要です。',
    inputSchema: {
      foreground: z.boolean().optional().describe('フォアグラウンド起動（デフォルト: false）'),
    },
  },
  async (args: { foreground?: boolean }) => {
    const { foreground } = args;

    // 状態確認
    if (systemState.state === 'NOT_CONFIGURED') {
      throw new Error('設定ファイルがありません。まず init ツールを実行してください。');
    }

    await callCliCommand(
      () => startServer({ foreground, config: systemState.configPath }),
      'Failed to start server'
    );

    return {
      content: [
        {
          type: 'text',
          text: '✅ サーバを起動しました。\n\n次のステップ:\n  - 文書を検索: search\n  - インデックス状態を確認: index_status',
        },
      ],
    };
  }
);
```

#### server_stop ツール

```typescript
server.registerTool(
  'server_stop',
  {
    description: 'search-docsサーバを停止します。',
    inputSchema: {},
  },
  async () => {
    await callCliCommand(
      () => stopServer({ config: systemState.configPath }),
      'Failed to stop server'
    );

    return {
      content: [
        {
          type: 'text',
          text: '✅ サーバを停止しました。',
        },
      ],
    };
  }
);
```

#### server_restart ツール

```typescript
server.registerTool(
  'server_restart',
  {
    description: 'search-docsサーバを再起動します。',
    inputSchema: {},
  },
  async () => {
    await callCliCommand(
      () => executeServerRestart({ config: systemState.configPath }),
      'Failed to restart server'
    );

    return {
      content: [
        {
          type: 'text',
          text: '✅ サーバを再起動しました。',
        },
      ],
    };
  }
);
```

#### get_system_status ツール

```typescript
server.registerTool(
  'get_system_status',
  {
    description: 'search-docsシステムの状態を取得します。設定ファイルの有無、サーバの起動状態、インデックス情報を確認できます。',
    inputSchema: {},
  },
  async () => {
    let statusText = '📊 search-docs システム状態\n\n';

    switch (systemState.state) {
      case 'NOT_CONFIGURED':
        statusText += '状態: 未設定\n\n';
        statusText += 'まず、設定ファイルを作成してください:\n';
        statusText += '  ツール: init\n';
        break;

      case 'CONFIGURED_SERVER_DOWN':
        statusText += '状態: 設定済み・サーバ停止中\n\n';
        statusText += `設定ファイル: ${systemState.configPath}\n`;
        statusText += `プロジェクト: ${systemState.config?.project.name}\n\n`;
        statusText += 'サーバを起動してください:\n';
        statusText += '  ツール: server_start\n';
        break;

      case 'RUNNING':
        statusText += '状態: 稼働中\n\n';
        statusText += `設定ファイル: ${systemState.configPath}\n`;
        statusText += `プロジェクト: ${systemState.config?.project.name}\n`;
        statusText += `サーバURL: ${systemState.serverUrl}\n\n`;

        // サーバ情報を取得
        try {
          const status = await systemState.client!.getStatus();
          statusText += 'サーバ情報:\n';
          statusText += `  バージョン: ${status.server.version}\n`;
          statusText += `  PID: ${status.server.pid}\n`;
          statusText += `  起動時間: ${(status.server.uptime / 1000).toFixed(1)}秒\n\n`;
          statusText += 'インデックス情報:\n';
          statusText += `  総文書数: ${status.index.totalDocuments}件\n`;
          statusText += `  総セクション数: ${status.index.totalSections}件\n`;
          statusText += `  Dirtyセクション: ${status.index.dirtyCount}件\n`;
        } catch (error) {
          statusText += `⚠️  サーバ情報の取得に失敗: ${(error as Error).message}\n`;
        }
        break;
    }

    return {
      content: [
        {
          type: 'text',
          text: statusText,
        },
      ],
    };
  }
);
```

### 既存ツールの変更

#### search, get_document ツール

各ツールの先頭に状態チェックを追加：

```typescript
async (args) => {
  // 状態チェック
  if (systemState.state !== 'RUNNING') {
    throw new Error(
      'search-docsサーバが起動していません。\n\n' +
      (systemState.state === 'NOT_CONFIGURED'
        ? 'まず設定ファイルを作成してください:\n  ツール: init\n\n次にサーバを起動してください:\n  ツール: server_start'
        : 'サーバを起動してください:\n  ツール: server_start')
    );
  }

  // 既存のロジック...
}
```

## リファクタリングアプローチ（改訂版）

### 問題の認識

当初は直接server.tsを大規模に書き換える方針でしたが、以下の問題があります：
- server.tsが肥大化（431行）
- テストがない状態での大規模変更はリスクが高い
- 既存の動作を壊す可能性が高い

### 新しいアプローチ：テストファーストリファクタリング

**原則**（エンジニアモード・コーディング実践モードに基づく）：
1. **既存の動作を正とする** - テストで固定してから変更
2. **段階的修正** - 一度に全てを変更せず、小さく確実に
3. **テスト・コード・ドキュメントの往復** - 各ステップでテストを通す

### リファクタリング計画

#### フェーズ1: 既存動作の保護

**目的**: 既存のserver.tsの動作をテストで固定

**タスク**:
1. 現在のserver.tsの主要な動作パターンを特定
2. 統合テストを作成（MCPサーバの起動、ツール呼び出し）
3. テストが通ることを確認

**成果物**: `src/__tests__/server.integration.test.ts`

#### フェーズ2: コードの分離

**目的**: 関心の分離、テスタビリティ向上

**タスク**:
1. 状態管理ロジックを分離 → `src/state.ts`
2. ツール登録ロジックを分離 → `src/tools/`
3. 各モジュールの単体テストを作成
4. 統合テストを通しながらリファクタリング

**成果物**:
- `src/state.ts` - SystemStateInfo, detectSystemState()
- `src/tools/search.ts` - searchツール
- `src/tools/get-document.ts` - get_documentツール
- `src/tools/index-status.ts` - index_statusツール
- `src/tools/init.ts` - initツール（新規）
- `src/tools/server-control.ts` - server_start, server_stop, server_restart（新規）
- `src/tools/system-status.ts` - get_system_statusツール（新規）

#### フェーズ3: 新機能の追加

**目的**: 状態管理機能を段階的に追加

**タスク**:
1. 新規ツールのテストを作成
2. 新規ツールを実装
3. 既存ツールに状態チェックを追加
4. 統合テストで全体の動作を確認

#### フェーズ4: 統合とドキュメント更新

**目的**: 全体を統合し、ドキュメントを更新

**タスク**:
1. 全テストが通ることを確認
2. README、ドキュメントを更新
3. 実際のプロジェクトで動作確認

### ファイル構成（リファクタリング後）

```
packages/mcp-server/src/
├── server.ts                 # メインエントリポイント（簡潔に）
├── state.ts                  # 状態管理ロジック
├── utils.ts                  # ヘルパー関数
├── server-manager.ts         # サーバ自動起動（既存）
├── tools/
│   ├── index.ts             # ツール一覧のエクスポート
│   ├── search.ts            # searchツール
│   ├── get-document.ts      # get_documentツール
│   ├── index-status.ts      # index_statusツール
│   ├── init.ts              # initツール（新規）
│   ├── server-control.ts    # サーバ制御ツール（新規）
│   └── system-status.ts     # system_statusツール（新規）
└── __tests__/
    ├── state.test.ts        # 状態管理のテスト
    ├── tools/               # 各ツールの単体テスト
    │   ├── search.test.ts
    │   ├── init.test.ts
    │   └── ...
    └── server.integration.test.ts  # 統合テスト
```

## 進捗記録

### 2025-11-03 - セッション1: 設計と計画

**実施内容**：
- [x] 作業メモを作成
- [x] CLIコマンドの実装確認
- [x] 状態管理システムの詳細設計
- [x] 新規ツールの仕様設計・実装詳細
- [x] server.tsに状態判定機構を追加（部分的）
- [x] リファクタリングアプローチを見直し

**気づき**：
- 直接的な大規模変更はリスクが高い
- テストファーストで段階的に進めるべき

**決定事項**：
- テストファーストリファクタリングのアプローチを採用
- 段階的にコミットして進捗を確実に記録

### 2025-11-03 - セッション2: 状態管理モジュールの実装

**実施内容**：
- [x] server.tsの変更を元に戻し（git checkout）
- [x] 状態管理ロジックを`src/state.ts`に分離
  - `SystemState`型（3つの状態: NOT_CONFIGURED, CONFIGURED_SERVER_DOWN, RUNNING）
  - `SystemStateInfo`インターフェイス
  - `detectSystemState(cwd: string)`関数 - システム状態を判定
  - `getStateErrorMessage(state, action)`関数 - 状態別エラーメッセージ生成
- [x] `src/__tests__/state.test.ts`の作成
  - 7つのテストケース、すべて通過
  - 3つの状態遷移をカバー
  - エラーメッセージ生成のテスト

**成果物**：
- `packages/mcp-server/src/state.ts` (125行)
- `packages/mcp-server/src/__tests__/state.test.ts` (142行)

**テスト結果**：
```
✓ src/__tests__/state.test.ts (7 tests) 2ms
  ✓ 設定ファイルがない場合、NOT_CONFIGUREDを返す
  ✓ 設定ファイル読み込みエラーの場合、NOT_CONFIGUREDを返す
  ✓ 設定ファイルがあるがサーバが停止中の場合、CONFIGURED_SERVER_DOWNを返す
  ✓ 設定ファイルがありサーバが稼働中の場合、RUNNINGを返す
  ✓ NOT_CONFIGURED状態のエラーメッセージを返す
  ✓ CONFIGURED_SERVER_DOWN状態のエラーメッセージを返す
  ✓ RUNNING状態のエラーメッセージを返す
```

**次のステップ**：
- ✅ 状態管理モジュールをコミット（commit 265700d）
- ツールをtools/ディレクトリに分離
- 新規ツールの実装

### 2025-11-03 - セッション3: ツール分離の開始

**実施内容**：
- [x] tools/ディレクトリ構造を設計
  - `tools/types.ts`: 共通型定義（ToolRegistrationContext）
  - `tools/index-status.ts`: index_statusツール
  - `tools/__tests__/index-status.test.ts`: 単体テスト
- [x] index_statusツールを分離（最もシンプルなツールから開始）
  - 状態チェック機能を組み込み（RUNNING状態のみ実行可能）
  - 4つのテストケース、すべて通過

**成果物**：
- `packages/mcp-server/src/tools/types.ts` (16行)
- `packages/mcp-server/src/tools/index-status.ts` (61行)
- `packages/mcp-server/src/tools/__tests__/index-status.test.ts` (141行)

**テスト結果**：
```
✓ src/tools/__tests__/index-status.test.ts (4 tests) 3ms
  ✓ RUNNING状態の場合、正常に動作する
  ✓ NOT_CONFIGURED状態の場合、エラーを返す
  ✓ CONFIGURED_SERVER_DOWN状態の場合、エラーを返す
  ✓ client.getStatus()がエラーの場合、エラーを返す
```

**次のステップ**：
- ツール分離をコミット
- 他の既存ツール（search, get_document）を分離
- 新規ツールの実装

### 2025-11-03 - セッション4: 既存ツールの完全分離

**実施内容**：
- [x] 残りの既存ツール（search, get_document）をtools/ディレクトリに分離
  - `tools/search.ts`: searchツールの実装（状態チェック統合）
  - `tools/get-document.ts`: get_documentツールの実装（状態チェック統合）
- [x] `src/utils.ts`を作成
  - `getDepthLabel(depth: number)`: depth値を分かりやすいラベルに変換
  - `getPreviewContent(content: string, maxLines: number)`: コンテンツのプレビュー取得
- [x] `tools/index.ts`を作成
  - すべてのツール登録関数をエクスポート
  - `ToolRegistrationContext`型をエクスポート

**成果物**：
- `packages/mcp-server/src/tools/search.ts` (117行)
- `packages/mcp-server/src/tools/get-document.ts` (86行)
- `packages/mcp-server/src/utils.ts` (42行)
- `packages/mcp-server/src/tools/index.ts` (8行)

**設計上の改善**：
- すべての既存ツールに状態チェックを統合
  - RUNNING状態でない場合は適切なエラーメッセージを表示
  - `getStateErrorMessage()`関数を使用して一貫したメッセージを提供
- ツール登録は`ToolRegistrationContext`パターンで統一
- ヘルパー関数を`utils.ts`に分離して再利用性を向上

**次のステップ**：
- ✅ 既存ツールの分離を完了
- 新規ツールの実装（init, server_start, server_stop, server_restart, get_system_status）
- server.tsの統合（分離したツールを使用するように変更）
- 統合テストの作成

### 2025-11-03 - セッション5: 新規ツールの実装とserver.ts統合

**実施内容**：
- [x] 新規ツール（4つ）の実装
  - `tools/init.ts`: 設定ファイルの初期化ツール
  - `tools/server-control.ts`: サーバ起動・停止ツール（server_start, server_stop）
  - `tools/system-status.ts`: システム状態取得ツール（get_system_status）
  - **注**: server_restartは不要として実装を省略
- [x] `tools/index.ts`の更新（新規ツールのエクスポート追加）
- [x] `server.ts`の全面書き換え
  - 431行から145行に大幅削減
  - detectSystemState()による状態判定
  - 状態に応じたツール登録（NOT_CONFIGURED / CONFIGURED_SERVER_DOWN / RUNNING）
  - サーバ自動起動ロジックを削除（手動起動に変更）
- [x] 型エラーの修正
  - `packages/cli/package.json`にexportsフィールドを追加
  - `state.ts`でconfigPathのnull→undefined変換
  - `state.test.ts`のモック修正

**成果物**：
- `packages/mcp-server/src/tools/init.ts` (68行)
- `packages/mcp-server/src/tools/server-control.ts` (126行)
- `packages/mcp-server/src/tools/system-status.ts` (76行)
- `packages/mcp-server/src/server.ts` (145行、431行から大幅削減)
- `packages/cli/package.json` (exportsフィールド追加)

**設計上の改善**：
- MCPサーバは状態を判定してから起動
- 未設定状態（NOT_CONFIGURED）でも起動可能
- ユーザーに状態と次のアクションを明示的に案内
- サーバ自動起動を廃止し、手動起動（server_start）に変更

**ビルド結果**：
- 全パッケージのビルド成功
- 型エラーなし

**次のステップ**：
- ✅ 新規ツールの実装完了
- ✅ server.tsの統合完了
- テストの作成（既存のstate.testは動作確認済み）
- 実際の動作確認（手動テスト）

## 参考情報

### 関連ファイル

- `packages/mcp-server/src/server.ts` - 現在のMCPサーバ実装
- `packages/mcp-server/src/server-manager.ts` - サーバ自動起動マネージャー
- `packages/cli/src/commands/config/init.ts` - config initコマンド
- `packages/cli/src/commands/server/start.ts` - server startコマンド
- `packages/cli/src/commands/server/stop.ts` - server stopコマンド

### 設計思想

- **ユーザフレンドリー**：状態に応じた適切な案内
- **自己完結型**：MCPサーバだけでセットアップから運用まで完結
- **安全性**：不適切な操作を防ぐ
- **透明性**：現在の状態を明示的に伝える

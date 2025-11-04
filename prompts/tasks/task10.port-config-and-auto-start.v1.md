# Task 10: ポート設定修正とMCPサーバ自動起動

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

## 概要

- **日時**: 2025-01-30
- **継続セッション**: Task 9からの継続
- **主要実装**:
  1. CLIコマンドのポート設定読み込み修正
  2. MCP Serverサーバ自動起動機能
  3. ファイルウォッチャーのEMFILEエラー修正

## 背景・動機

前セッション（Task 9）でMCP Server実装とnpm公開（v1.0.0）が完了。
新セッションでポート設定の問題が発覚：

### 発覚した問題

1. **ポート設定が読まれない**
   - サーバ起動: 設定ファイルのポート番号を正しく読む ✅
   - CLIコマンド: ハードコードされた `http://localhost:24280` を使用 ❌
   - 問題: プロジェクト毎に異なるポートで複数サーバを立ち上げられない

2. **MCP Serverだけではサーバを起動できない**
   - `@search-docs/mcp-server` のみインストール → サーバ起動方法なし
   - `@search-docs/server` はライブラリとして提供（binエントリなし）
   - サーバ起動は `@search-docs/cli` が担当

3. **ファイルウォッチャーのEMFILEエラー**
   - `Error: EMFILE: too many open files, watch`
   - node_modulesなど大量のファイルを監視しようとして発生

## 実装内容

### 1. ポート設定の修正

#### 新規ファイル: `packages/cli/src/utils/server-url.ts`

```typescript
export async function resolveServerUrl(
  options: ResolveServerUrlOptions = {}
): Promise<string> {
  // 1. 明示的に指定されている場合は最優先
  if (options.server) {
    return options.server;
  }

  try {
    // 2. 設定ファイルからポート番号を取得
    const projectRoot = await findProjectRoot({
      configPath: options.config,
    });

    const configPath = await resolveConfigPath(projectRoot, options.config);
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent) as SearchDocsConfig;

    if (config.server) {
      const host = config.server.host || 'localhost';
      const port = config.server.port || 24280;
      return `http://${host}:${port}`;
    }
  } catch (error) {
    // 設定ファイルが読み込めない場合はデフォルトにフォールバック
  }

  // 3. デフォルト
  return 'http://localhost:24280';
}
```

**優先順位**:
1. `--server` オプション（明示的指定）
2. 設定ファイルの `server.host` + `server.port`
3. デフォルト: `http://localhost:24280`

#### 修正したファイル

1. **`packages/cli/src/commands/search.ts`**
   - `resolveServerUrl()` を使用
   - `--config` オプション追加

2. **`packages/cli/src/commands/index/rebuild.ts`**
   - `resolveServerUrl()` を使用
   - `--config` オプション追加

3. **`packages/cli/src/commands/index/status.ts`**
   - `resolveServerUrl()` を使用
   - `--config` オプション追加

4. **`packages/cli/src/index.ts`**
   - 各コマンドに `--config <path>` オプション追加
   - `--server` のデフォルト値を削除（resolveServerUrlで解決）

#### 使用例

```bash
# 設定ファイルでポート24281を指定
cat .search-docs.json
{
  "server": { "port": 24281 }
}

# サーバ起動（ポート24281）
search-docs server start

# 検索（自動的にポート24281に接続）
search-docs search "クエリ"

# または設定ファイルを明示的に指定
search-docs search "クエリ" --config .search-docs.json

# または直接サーバURLを指定（最優先）
search-docs search "クエリ" --server http://localhost:24281
```

### 2. MCP Serverサーバ自動起動機能

#### 新規ファイル: `packages/mcp-server/src/server-manager.ts`

```typescript
export class ServerManager {
  /**
   * @search-docs/cliパッケージのエントリポイントを解決
   */
  private async resolveCliPath(): Promise<string> {
    // import.meta.resolve()でパスを解決
    const cliPackage = await import.meta.resolve('@search-docs/cli');

    // file:// プロトコルを削除してファイルパスに変換
    const cliPackagePath = cliPackage.replace(/^file:\/\//, '');
    const cliDir = path.dirname(cliPackagePath);
    const cliEntryPoint = path.join(cliDir, 'dist', 'index.js');

    await fs.access(cliEntryPoint);
    return cliEntryPoint;
  }

  /**
   * サーバを起動
   */
  async startServer(projectDir: string, port: number, configPath?: string): Promise<void> {
    const cliPath = await this.resolveCliPath();

    const args = ['server', 'start', '--port', port.toString()];
    if (configPath) {
      args.push('--config', configPath);
    }

    const serverProcess = spawn(
      'node',
      [cliPath, ...args],
      {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false, // MCP終了時にサーバも終了
      }
    );

    // ... エラーハンドリングとログ出力
  }
}
```

#### 修正ファイル: `packages/mcp-server/src/server.ts`

```typescript
async function main() {
  const { projectDir } = parseArgs();
  const config = await loadConfig(projectDir);
  const serverUrl = `http://${config.server.host}:${config.server.port}`;
  const client = new SearchDocsClient({ baseUrl: serverUrl });

  const serverManager = new ServerManager();

  // プロセス終了時のクリーンアップ
  process.on('SIGINT', () => {
    serverManager.cleanup();
    process.exit(0);
  });

  // 接続確認
  try {
    await client.healthCheck();
    console.error('[mcp-server] Connection established');
  } catch (error) {
    console.error('[mcp-server] Server is not running, attempting to start...');

    // サーバを自動起動
    const configPath = path.join(projectDir, '.search-docs.json');
    await serverManager.startServer(projectDir, config.server.port, configPath);

    // 起動後、再度接続確認
    await client.healthCheck();
    console.error('[mcp-server] Successfully connected to auto-started server');
  }

  // MCPサーバの初期化...
}
```

#### 依存関係追加: `packages/mcp-server/package.json`

```json
{
  "dependencies": {
    "@search-docs/cli": "workspace:*",  // 追加
    "@search-docs/client": "workspace:*",
    "@search-docs/types": "workspace:*",
    // ...
  }
}
```

#### 動作フロー

```
MCP Server起動
  ↓
設定ファイル読み込み (.search-docs.json)
  ↓
サーバ接続確認 (healthCheck)
  ↓
  ├─ 成功 → MCP Serverとして動作開始
  └─ 失敗 → サーバ自動起動
       ↓
     import.meta.resolve('@search-docs/cli')
       ↓
     node <cli-path> server start --port <port> --config <config>
       ↓
     再度接続確認 (2秒待機後)
       ↓
       ├─ 成功 → MCP Serverとして動作開始
       └─ 失敗 → エラーメッセージ表示して終了
```

### 3. ファイルウォッチャーのEMFILEエラー修正

#### 修正ファイル: `packages/server/src/discovery/file-watcher.ts`

**問題**: `this.rootDir` 全体を監視 → node_modulesなど大量ファイルを開こうとしてEMFILE

**解決策**: ディレクトリレベルで除外

```typescript
this.watcher = chokidar.watch(this.rootDir, {
  ignored: (filePath: string, stats?: Stats) => {
    const relativePath = path.relative(this.rootDir, filePath);
    const isDirectory = stats?.isDirectory() || !path.extname(filePath);

    if (isDirectory) {
      // node_modules, .git, dist, buildなどを除外
      const dirName = path.basename(filePath);
      const commonIgnores = [
        'node_modules',
        '.git',
        '.venv',
        'dist',
        'build',
        '.next',
        '.turbo',
        'coverage',
        '.cache',
      ];
      if (commonIgnores.includes(dirName)) {
        return true; // 除外
      }
      return false;
    }

    // ファイルの除外チェック...
  },
  persistent: true,
  ignoreInitial: true,
  depth: 99,
  awaitWriteFinish: {
    stabilityThreshold: this.watcherConfig.awaitWriteFinishMs,
    pollInterval: 100,
  },
  // ファイルディスクリプタ使用量を削減
  usePolling: false, // ネイティブfsEventsを使用（Mac）
  atomic: true, // アトミックな書き込みを処理
});
```

**効果**:
- ディレクトリ名でフィルタリング → ファイルを開く前に除外
- `usePolling: false` → ネイティブfsEvents使用（Mac）
- EMFILE エラーを回避

## 技術的な詳細

### import.meta.resolve()の使用

Node.js 20.6.0+ で利用可能な機能：

```typescript
const cliPackage = await import.meta.resolve('@search-docs/cli');
// → "file:///usr/local/lib/node_modules/@search-docs/cli/dist/index.js"

const cliPath = cliPackage.replace(/^file:\/\//, '');
// → "/usr/local/lib/node_modules/@search-docs/cli/dist/index.js"
```

**利点**:
- パッケージの実際のインストール場所を解決
- グローバル/ローカルインストールどちらでも動作
- シンボリックリンクも解決

### spawn()による別プロセス起動

```typescript
const serverProcess = spawn(
  'node',
  [cliPath, 'server', 'start', '--port', port.toString()],
  {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false, // 親プロセス終了時に子プロセスも終了
  }
);
```

**特徴**:
- `detached: false` → MCP終了時にサーバも自動終了
- `stdio: ['ignore', 'pipe', 'pipe']` → stdout/stderrをキャプチャしてログ出力
- `cwd: projectDir` → プロジェクトディレクトリで実行

## ビルドと動作確認

### ビルド

```bash
# 全パッケージビルド
pnpm run build:all

# 個別パッケージビルド
pnpm --filter @search-docs/cli build
pnpm --filter @search-docs/mcp-server build
pnpm --filter @search-docs/server build
```

### 動作確認

#### CLIコマンドのヘルプ確認

```bash
cd packages/cli
node dist/index.js search --help
# Options:
#   --server <url>   サーバURL
#   --config <path>  設定ファイルのパス  ← 追加された

node dist/index.js index rebuild --help
# Options:
#   --server <url>   サーバURL
#   --config <path>  設定ファイルのパス  ← 追加された

node dist/index.js index status --help
# Options:
#   --server <url>   サーバURL
#   --config <path>  設定ファイルのパス  ← 追加された
```

#### MCP Serverのビルド確認

```bash
ls packages/mcp-server/dist/
# server-manager.js  ← 新規作成
# server.js
```

## インストールパターン

### パターン1: CLIのみ

```bash
npm install -g @search-docs/cli
```

**コマンド名**: `search-docs`

**用途**:
- サーバの手動起動・停止・管理
- コマンドラインからの検索
- インデックス管理

### パターン2: MCP Serverのみ（推奨）

```bash
npm install -g @search-docs/mcp-server
```

**コマンド名**: `search-docs-mcp`

**依存関係**:
- 内部的に `@search-docs/cli` も依存としてインストールされる
- サーバ自動起動機能により、CLIを意識する必要なし

**用途**:
- Claude Codeとの統合
- MCP Server経由での検索
- サーバは自動起動・管理

### パターン3: 両方

```bash
npm install -g @search-docs/cli @search-docs/mcp-server
```

**用途**:
- CLIでの手動操作とMCP統合の両方

## 発見した問題と解決

### 問題1: MCP Serverが@search-docs/serverを直接起動できない

**発見**: `@search-docs/server` はライブラリとして提供され、`bin` エントリポイントがない

**当初の誤解**:
```typescript
// これはできない
import.meta.resolve('@search-docs/server')
// → dist/index.js はライブラリのexport、実行可能ではない
```

**解決策**: `@search-docs/cli` を経由してサーバを起動

```typescript
import.meta.resolve('@search-docs/cli')
// → dist/index.js は実行可能なCLIエントリポイント
node <cli-path> server start
```

### 問題2: postinstallスクリプトのエラー

```bash
pnpm install
# . postinstall$ uv sync
# . postinstall: error: No `pyproject.toml` found
```

**原因**: ルートの `package.json` に `postinstall: "uv sync"` があるが、一部環境でpyproject.tomlが見つからない

**対処**: エラーは無視してビルド続行（Python環境は別途セットアップ）

## 次のステップ（今後の課題）

### 今回実装しなかった項目

1. **MCP Serverの終了時処理改善**
   - 現在: `detached: false` でプロセス連動
   - 改善案: PIDファイル管理、グレースフルシャットダウン

2. **サーバ起動の待機時間最適化**
   - 現在: 固定2秒待機
   - 改善案: healthCheckをリトライして実際の起動を確認

3. **複数プロジェクトの同時サーバ管理**
   - 現在: 各MCP Serverが独立してサーバ起動
   - 改善案: ポートの自動割り当て、既存サーバの再利用

4. **エラーハンドリングの強化**
   - CLIが見つからない場合のフォールバック
   - サーバ起動失敗時のリトライ戦略

## まとめ

### 実装完了

✅ CLIコマンドのポート設定読み込み
✅ MCP Serverサーバ自動起動機能
✅ ファイルウォッチャーのEMFILEエラー修正
✅ ビルド確認

### インストールの簡素化

**変更前**:
```bash
npm install -g @search-docs/cli @search-docs/mcp-server
search-docs server start  # 手動起動が必要
search-docs-mcp --project-dir .
```

**変更後**:
```bash
npm install -g @search-docs/mcp-server  # これだけでOK
search-docs-mcp --project-dir .  # サーバは自動起動
```

### コマンド名

- **CLI**: `search-docs`
- **MCP Server**: `search-docs-mcp`

---

**作業完了日時**: 2025-01-30 21:56
**次回継続予定**: v1.0.1リリース準備（changeset作成、テスト、公開）

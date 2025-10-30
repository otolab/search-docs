# サーバプロセス管理仕様

## 概要

search-docsは「1プロジェクト1サーバプロセス」の原則で運用します。各プロジェクトディレクトリごとに独立したサーバプロセスが起動し、そのプロジェクト専用の文書インデックスと検索サービスを提供します。

## 基本原則

### 1プロジェクト1サーバプロセス

- **定義**: 1つのプロジェクトディレクトリに対して、最大1つのsearch-docsサーバプロセスが起動する
- **目的**: リソースの効率的利用、設定の分離、プロセス管理の簡素化
- **複数プロジェクト**: 異なるプロジェクトでは異なるポートで同時に複数のサーバを起動可能

### プロジェクトの識別

プロジェクトは以下の要素で一意に識別されます：

1. **プロジェクトルートの絶対パス**: 正規化された絶対パス
2. **設定ファイルパス**: プロジェクトルート内の設定ファイル（`.search-docs.json`など）

## プロジェクトルートの決定方法

### 優先順位

サーバ起動時、以下の順序でプロジェクトルートを決定します：

1. **設定ファイルで明示的に指定**
   ```json
   {
     "project": {
       "root": "/path/to/project"
     }
   }
   ```

2. **設定ファイルが配置されているディレクトリ**
   - `--config`オプションで指定された設定ファイルの親ディレクトリ
   - 例: `--config /path/to/project/.search-docs.json` → root: `/path/to/project`

3. **カレントワーキングディレクトリ (CWD)**
   - 設定ファイルが指定されていない場合
   - デフォルト: `process.cwd()`

### パス正規化

プロジェクトルートは以下のように正規化されます：

```typescript
import * as path from 'path';

function normalizeProjectRoot(root: string): string {
  // 絶対パスに変換
  const absolutePath = path.resolve(root);

  // シンボリックリンクを解決
  const realPath = fs.realpathSync(absolutePath);

  // 末尾のスラッシュを削除
  return realPath.replace(/\/$/, '');
}
```

**例**:
- `./` → `/Users/user/my-project`
- `~/projects/docs` → `/Users/user/projects/docs`
- `/path/to/../project` → `/path/project`

## PIDファイル管理

### 配置場所

PIDファイルはプロジェクトルート内の`.search-docs/`ディレクトリに配置されます：

```
<project-root>/
└── .search-docs/
    ├── server.pid      # PIDファイル
    ├── server.log      # サーバログ（オプション）
    ├── documents/      # ドキュメントストレージ
    └── index/          # LanceDB インデックス
```

**パス**: `<project-root>/.search-docs/server.pid`

### PIDファイルの命名

- **固定名**: `server.pid`
- **理由**: 1プロジェクト1サーバなので、固定名で十分

### PIDファイルの形式

JSON形式で以下の情報を保存します：

```typescript
interface PidFileContent {
  // プロセス情報
  pid: number;                // プロセスID
  startedAt: string;          // 起動時刻（ISO 8601形式）

  // プロジェクト情報
  projectRoot: string;        // プロジェクトルートの絶対パス
  projectName: string;        // プロジェクト名

  // サーバ設定
  host: string;               // サーバホスト
  port: number;               // サーバポート
  configPath: string;         // 設定ファイルの絶対パス

  // ログ情報（オプション）
  logPath?: string;           // ログファイルパス

  // メタ情報
  version: string;            // search-docsのバージョン
  nodeVersion: string;        // Node.jsのバージョン
}
```

**例**:
```json
{
  "pid": 12345,
  "startedAt": "2025-10-28T15:00:00.000Z",
  "projectRoot": "/Users/user/my-project",
  "projectName": "my-project",
  "host": "localhost",
  "port": 24280,
  "configPath": "/Users/user/my-project/.search-docs.json",
  "logPath": "/Users/user/my-project/.search-docs/server.log",
  "version": "0.1.0",
  "nodeVersion": "v22.11.0"
}
```

### PIDファイルの操作

#### 作成

```typescript
async function writePidFile(content: PidFileContent): Promise<void> {
  const pidFilePath = path.join(content.projectRoot, '.search-docs', 'server.pid');

  // .search-docsディレクトリが存在しない場合は作成
  await fs.mkdir(path.dirname(pidFilePath), { recursive: true });

  // PIDファイル書き込み
  await fs.writeFile(
    pidFilePath,
    JSON.stringify(content, null, 2),
    'utf-8'
  );
}
```

#### 読み込み

```typescript
async function readPidFile(projectRoot: string): Promise<PidFileContent | null> {
  const pidFilePath = path.join(projectRoot, '.search-docs', 'server.pid');

  try {
    const content = await fs.readFile(pidFilePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;  // ファイルが存在しない
    }
    throw error;
  }
}
```

#### 削除

```typescript
async function deletePidFile(projectRoot: string): Promise<void> {
  const pidFilePath = path.join(projectRoot, '.search-docs', 'server.pid');

  try {
    await fs.unlink(pidFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // ファイルが存在しない場合は無視
      return;
    }
    throw error;
  }
}
```

## プロセスライフサイクル管理

### 起動フロー

```
1. プロジェクトルート決定
   ↓
2. 設定ファイル読み込み
   ↓
3. 既存プロセスチェック
   ├─ PIDファイル存在？
   │  ├─ YES → プロセス生存確認
   │  │         ├─ 生存中 → エラー（既に起動中）
   │  │         └─ 死亡 → 古いPIDファイル削除
   │  └─ NO → 続行
   ↓
4. ポート利用可能性チェック
   ├─ 使用中？
   │  ├─ YES → エラー（ポート競合）
   │  └─ NO → 続行
   ↓
5. サーバプロセス起動
   ├─ デーモンモード: detached spawn
   └─ フォアグラウンド: 通常spawn
   ↓
6. PIDファイル作成
   ↓
7. 起動完了確認
   ├─ ヘルスチェック（/health）
   └─ タイムアウト: 30秒
   ↓
8. 起動成功
```

### 停止フロー

```
1. PIDファイル読み込み
   ├─ 存在しない → エラー（サーバが起動していない）
   └─ 存在する → 続行
   ↓
2. プロセス生存確認
   ├─ 死亡 → 警告（既に停止済み）→ PIDファイル削除
   └─ 生存中 → 続行
   ↓
3. 停止シグナル送信（SIGTERM）
   ↓
4. 停止待機（最大5秒）
   ├─ タイムアウト → 強制停止（SIGKILL）
   └─ 正常停止 → 続行
   ↓
5. PIDファイル削除
   ↓
6. 停止完了
```

### 再起動フロー

```
1. 停止フロー実行
   ↓
2. 起動フロー実行
```

## 重複起動の防止

### チェック方法

1. **PIDファイルの存在確認**
   ```typescript
   const pidFile = await readPidFile(projectRoot);
   if (pidFile) {
     // PIDファイルが存在する
   }
   ```

2. **プロセス生存確認**
   ```typescript
   function isProcessAlive(pid: number): boolean {
     try {
       // シグナル0は実際にシグナルを送らず、プロセスの存在のみチェック
       process.kill(pid, 0);
       return true;
     } catch (error) {
       return false;
     }
   }
   ```

3. **ポート利用可能性確認**
   ```typescript
   async function isPortAvailable(port: number): Promise<boolean> {
     return new Promise((resolve) => {
       const server = net.createServer();

       server.once('error', (err: NodeJS.ErrnoException) => {
         if (err.code === 'EADDRINUSE') {
           resolve(false);  // ポート使用中
         }
       });

       server.once('listening', () => {
         server.close();
         resolve(true);  // ポート利用可能
       });

       server.listen(port);
     });
   }
   ```

### エラーメッセージ

```typescript
// 既に起動中
throw new Error(
  `Server is already running for this project.\n` +
  `  PID: ${pidFile.pid}\n` +
  `  Started: ${pidFile.startedAt}\n` +
  `  Port: ${pidFile.port}\n` +
  `\n` +
  `To stop the server, run: search-docs server stop`
);

// ポート競合
throw new Error(
  `Port ${port} is already in use.\n` +
  `Please specify a different port with --port option.`
);
```

## 異常終了の検出と復旧

### 異常終了の検出

プロセスが異常終了した場合、PIDファイルが残ったままになります。

**検出方法**:
```typescript
const pidFile = await readPidFile(projectRoot);

if (pidFile) {
  const isAlive = isProcessAlive(pidFile.pid);

  if (!isAlive) {
    // プロセスは既に終了しているが、PIDファイルが残っている
    console.warn(
      `Found stale PID file. Previous server (PID: ${pidFile.pid}) is not running.`
    );
  }
}
```

### 復旧方法

1. **古いPIDファイルの削除**
   ```typescript
   if (pidFile && !isProcessAlive(pidFile.pid)) {
     console.log('Removing stale PID file...');
     await deletePidFile(projectRoot);
   }
   ```

2. **新しいサーバの起動**
   - 古いPIDファイルを削除後、通常の起動フローを実行

### クリーンアップコマンド

異常終了時の手動復旧用：

```bash
# 古いPIDファイルを削除
rm .search-docs/server.pid

# またはCLIコマンドで
search-docs server clean
```

## ポート管理

### デフォルトポート

- **デフォルト**: `24280`
- **理由**: 他の一般的なサービスと競合しにくい番号

### ポート指定

起動時にポートを指定可能：

```bash
search-docs server start --port 24281
```

### ポート競合時の動作

1. **指定ポートが使用中**
   - エラーを返し、起動を中止
   - 別のポートを指定するよう促す

2. **自動ポート割り当て（将来の拡張）**
   - `--port auto`で空いているポートを自動検索
   - 検索範囲: 24280-24289

### 複数プロジェクトでのポート管理

異なるプロジェクトで同時にサーバを起動する場合：

```bash
# プロジェクトA（デフォルトポート）
cd /path/to/projectA
search-docs server start

# プロジェクトB（別ポート）
cd /path/to/projectB
search-docs server start --port 24281

# プロジェクトC（別ポート）
cd /path/to/projectC
search-docs server start --port 24282
```

各プロジェクトのPIDファイルに使用ポートが記録されます。

## プロセス生存確認

### 確認方法

```typescript
function isProcessAlive(pid: number): boolean {
  try {
    // シグナル0でプロセスの存在確認
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ESRCH') {
      // プロセスが存在しない
      return false;
    }

    if (err.code === 'EPERM') {
      // 権限がないが、プロセスは存在する
      return true;
    }

    return false;
  }
}
```

### ヘルスチェック

プロセスが生存していても、サーバが正常に動作しているとは限りません。

**ヘルスチェックエンドポイント**:
```
GET http://localhost:24280/health
```

**レスポンス**:
```json
{
  "status": "ok"
}
```

**完全な生存確認**:
```typescript
async function isServerHealthy(pidFile: PidFileContent): Promise<boolean> {
  // 1. プロセス生存確認
  if (!isProcessAlive(pidFile.pid)) {
    return false;
  }

  // 2. ヘルスチェック
  try {
    const response = await fetch(`http://${pidFile.host}:${pidFile.port}/health`, {
      signal: AbortSignal.timeout(3000),  // 3秒タイムアウト
    });

    if (response.ok) {
      const data = await response.json();
      return data.status === 'ok';
    }
  } catch (error) {
    return false;
  }

  return false;
}
```

## クロスプラットフォーム対応

### Windows

- **プロセスシグナル**: WindowsではSIGTERMが完全にサポートされていない
  - 代替: `taskkill /PID <pid>` コマンド使用
- **デーモン化**: `detached`オプションの動作が異なる
  - Windowsでは新しいコンソールウィンドウが作成される

```typescript
function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    // Windows: taskkillを使用
    spawn('taskkill', ['/pid', pid.toString(), '/f', '/t']);
  } else {
    // Unix系: SIGTERMを送信
    process.kill(pid, 'SIGTERM');
  }
}
```

### macOS / Linux

- **プロセスシグナル**: SIGTERM、SIGKILLが正常に動作
- **デーモン化**: `detached + unref()`で正常に動作

## セキュリティ考慮事項

### PIDファイルのパーミッション

- **推奨**: `0600` (所有者のみ読み書き可能)
- **理由**: 他ユーザーによる不正なプロセス停止を防止

```typescript
async function writePidFile(content: PidFileContent): Promise<void> {
  const pidFilePath = path.join(content.projectRoot, '.search-docs', 'server.pid');

  await fs.writeFile(pidFilePath, JSON.stringify(content, null, 2), {
    mode: 0o600,  // rw-------
  });
}
```

### プロセス権限

- サーバプロセスは通常ユーザー権限で実行
- rootやsudo実行は推奨しない

## エラーハンドリング

### 起動時のエラー

| エラー | 原因 | 対処 |
|--------|------|------|
| `Server already running` | 既にサーバが起動中 | `server stop`で停止してから再起動 |
| `Port in use` | ポートが使用中 | `--port`で別ポートを指定 |
| `Config file not found` | 設定ファイルが存在しない | `.search-docs.json`を手動作成 |
| `Invalid config` | 設定ファイルが不正 | 設定ファイルの構文を確認 |

### 停止時のエラー

| エラー | 原因 | 対処 |
|--------|------|------|
| `Server not running` | サーバが起動していない | エラー無視、または起動確認 |
| `PID file not found` | PIDファイルが存在しない | サーバが異常終了した可能性 |
| `Process not found` | プロセスが既に終了 | PIDファイル削除のみ実行 |

## 実装例

### server start コマンド

```typescript
async function serverStart(options: ServerStartOptions): Promise<void> {
  // 1. プロジェクトルート決定
  const projectRoot = await findProjectRoot(options.config);

  // 2. 設定ファイル読み込み
  const config = await ConfigLoader.load(options.config || path.join(projectRoot, '.search-docs.json'));

  // 3. 既存プロセスチェック
  const existingPid = await readPidFile(projectRoot);
  if (existingPid && isProcessAlive(existingPid.pid)) {
    throw new Error(`Server is already running (PID: ${existingPid.pid})`);
  }

  // 4. 古いPIDファイル削除
  if (existingPid) {
    await deletePidFile(projectRoot);
  }

  // 5. ポート確認
  const port = options.port || config.server.port;
  if (!await isPortAvailable(port)) {
    throw new Error(`Port ${port} is already in use`);
  }

  // 6. サーバプロセス起動
  const serverScript = path.join(__dirname, '../../server/dist/bin/server.js');
  const serverProcess = spawn('node', [serverScript], {
    detached: options.daemon,
    stdio: options.daemon ? 'ignore' : 'inherit',
    env: {
      ...process.env,
      SEARCH_DOCS_CONFIG: config.configPath,
    },
  });

  // 7. PIDファイル作成
  await writePidFile({
    pid: serverProcess.pid!,
    startedAt: new Date().toISOString(),
    projectRoot,
    projectName: config.project.name,
    host: config.server.host,
    port,
    configPath: config.configPath,
    version: packageJson.version,
    nodeVersion: process.version,
  });

  // 8. デーモンモードの場合はunref
  if (options.daemon) {
    serverProcess.unref();
  }

  console.log(`Server started successfully (PID: ${serverProcess.pid})`);
}
```

## まとめ

### 重要なポイント

1. **1プロジェクト1サーバ**: プロジェクトルートごとに最大1つのサーバプロセス
2. **PIDファイル管理**: `.search-docs/server.pid`で状態管理
3. **重複起動防止**: PIDファイルとプロセス生存確認の組み合わせ
4. **異常終了対応**: 古いPIDファイルの自動削除
5. **ポート管理**: デフォルト24280、複数プロジェクトは異なるポートで起動

### 次のステップ

この仕様に基づいて、以下を実装します：

1. `src/utils/pid.ts` - PIDファイル管理
2. `src/utils/process.ts` - プロセス管理
3. `src/commands/server/*.ts` - serverコマンド群

---

**作成日**: 2025-10-28
**バージョン**: 1.0
**状態**: 仕様確定

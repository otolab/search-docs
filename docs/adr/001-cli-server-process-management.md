# ADR-001: CLIサーバプロセス管理の実装方針

**日付**: 2025-10-28
**ステータス**: 採用
**関連**: CLI実装、サーバプロセス管理

## コンテキスト

search-docs CLIツールでサーバプロセスを管理する機能を実装するにあたり、以下の要件を満たす必要がある：

1. **1プロジェクト1サーバプロセス**: 各プロジェクトディレクトリごとに最大1つのサーバプロセスを起動
2. **複数プロジェクト対応**: 異なるプロジェクトでは同時に複数サーバを起動可能
3. **プロセス管理**: サーバの起動・停止・状態確認を安全に実行
4. **異常終了対応**: サーバが異常終了した場合の復旧
5. **クロスプラットフォーム**: Windows/macOS/Linuxで動作

## 決定

### 1. プロジェクト識別とPIDファイル管理

#### 決定内容

**プロジェクトの一意識別**:
- プロジェクトルートの正規化された絶対パスで識別
- シンボリックリンクを解決して実体パスを使用

**PIDファイル配置**:
- 場所: `<project-root>/.search-docs/server.pid`
- 形式: JSON
- パーミッション: `0600` (所有者のみ読み書き可能)

**PIDファイル内容**:
```json
{
  "pid": 12345,
  "startedAt": "2025-10-28T15:00:00.000Z",
  "projectRoot": "/Users/user/my-project",
  "projectName": "my-project",
  "host": "localhost",
  "port": 24280,
  "configPath": "/Users/user/my-project/.search-docs.json",
  "version": "0.1.0",
  "nodeVersion": "v22.11.0"
}
```

#### 理由

- **固定名のPIDファイル**: 1プロジェクト1サーバなので、複雑な命名スキームは不要
- **プロジェクトルート内配置**: プロジェクト固有の状態として管理、.gitignore対象
- **JSON形式**: 将来的な拡張性、デバッグ時の可読性
- **0600パーミッション**: セキュリティ強化、他ユーザーによる不正操作防止
- **メタ情報の保存**: デバッグやトラブルシューティングに有用

#### トレードオフ

- **採用案の利点**:
  - シンプルで実装が容易
  - プロジェクトごとに完全に独立
  - プロジェクトディレクトリの削除で状態もクリーンアップ

- **不採用案**: グローバルなPIDファイル管理
  - システム全体で1ヶ所に集約（例: `~/.search-docs/pids/`）
  - 複雑な命名スキーム（プロジェクトパスのハッシュ等）が必要
  - プロジェクト削除時にPIDファイルが残留する可能性

### 2. プロジェクトルートの決定方法

#### 決定内容

以下の優先順位でプロジェクトルートを決定：

1. **設定ファイルの`project.root`フィールド** (最優先)
2. **設定ファイルの親ディレクトリ** (`--config`オプション指定時)
3. **カレントワーキングディレクトリ** (デフォルト)

**正規化処理**:
```typescript
async function normalizeProjectRoot(root: string): Promise<string> {
  const absolutePath = path.resolve(root);
  const realPath = await fs.realpath(absolutePath);
  return realPath.replace(/\/$/, '');
}
```

#### 理由

- **明示性**: ユーザーが意図したプロジェクトルートを確実に使用
- **柔軟性**: 設定ファイルの場所とプロジェクトルートを分離可能
- **一貫性**: 常に絶対パスで管理、シンボリックリンクの影響を排除

#### トレードオフ

- **採用案の利点**:
  - 予測可能な動作
  - 設定ファイルとプロジェクトルートの分離が可能
  - シンボリックリンク環境でも正常動作

- **不採用案**: .git ディレクトリベースの検索
  - Gitリポジトリでないプロジェクトには対応不可
  - モノレポ構成で誤動作の可能性

### 3. 重複起動防止の3段階チェック

#### 決定内容

サーバ起動時に以下の3段階でチェック：

1. **PIDファイルの存在確認**
   ```typescript
   const pidFile = await readPidFile(projectRoot);
   ```

2. **プロセス生存確認**
   ```typescript
   function isProcessAlive(pid: number): boolean {
     try {
       process.kill(pid, 0);  // シグナル0で存在確認のみ
       return true;
     } catch {
       return false;
     }
   }
   ```

3. **ポート利用可能性確認**
   ```typescript
   async function isPortAvailable(port: number): Promise<boolean> {
     // net.createServerで試行
   }
   ```

#### 理由

- **PIDファイル存在確認**: 高速な初期チェック
- **プロセス生存確認**: PIDファイルが古い（異常終了）場合を検出
- **ポート確認**: プロセスは生きているが別のサービスがポート使用中を検出

#### トレードオフ

- **採用案の利点**:
  - 堅牢性が高い
  - 異常終了を自動検出
  - ポート競合を事前に検出

- **不採用案**: PIDファイルのみでチェック
  - シンプルだが異常終了時に対応不可
  - ポート競合を検出できない

### 4. クロスプラットフォーム対応

#### 決定内容

**プラットフォーム判定**:
```typescript
if (process.platform === 'win32') {
  // Windows固有の処理
} else {
  // Unix系の処理
}
```

**プロセス停止の実装**:

- **Unix系 (macOS/Linux)**:
  ```typescript
  process.kill(pid, 'SIGTERM');  // 優雅な停止
  // タイムアウト後
  process.kill(pid, 'SIGKILL');  // 強制停止
  ```

- **Windows**:
  ```typescript
  spawn('taskkill', ['/PID', pid.toString(), '/T']);  // 優雅な停止
  // タイムアウト後
  spawn('taskkill', ['/PID', pid.toString(), '/F', '/T']);  // 強制停止
  ```

#### 理由

- **Node.js標準API優先**: `process.kill()`はNode.js標準で可搬性が高い
- **Windowsの特性考慮**: SIGTERMが完全にサポートされていないため`taskkill`使用
- **サブプロセス終了**: `/T`フラグでサブプロセスも確実に終了

#### トレードオフ

- **採用案の利点**:
  - 主要3プラットフォームで動作
  - Node.js標準APIで実装が容易
  - 外部依存なし

- **不採用案**: pm2などのプロセス管理ツール使用
  - 外部依存が増える
  - ユーザーの環境に依存

### 5. デーモン化の実装方法

#### 決定内容

**デーモン起動**:
```typescript
const serverProcess = spawn('node', [serverScript], {
  detached: true,           // 親プロセスから切り離し
  stdio: ['ignore', 'ignore', 'ignore'],  // 現状はignore
});
serverProcess.unref();      // 親プロセス終了を待たない
```

**将来的なログ出力対応**:
```typescript
// ログファイルが指定された場合（将来実装）
const logFd = fs.openSync(logPath, 'a');
stdio: ['ignore', logFd, logFd]
```

#### 理由

- **シンプルな実装**: Node.js標準APIのみで実現
- **外部依存なし**: pm2等の外部ツール不要
- **拡張性**: ログファイル対応を後から追加可能

#### トレードオフ

- **採用案の利点**:
  - 軽量、外部依存なし
  - プラットフォーム標準機能のみ使用
  - 段階的な機能追加が可能

- **不採用案**: pm2/forever等のデーモンツール
  - 高機能（自動再起動、ログローテーション等）
  - 外部依存が増える
  - オーバースペックの可能性

### 6. 異常終了時の復旧戦略

#### 決定内容

**検出方法**:
```typescript
const pidFile = await readPidFile(projectRoot);
if (pidFile && !isProcessAlive(pidFile.pid)) {
  // 異常終了を検出
  console.warn('Found stale PID file. Cleaning up...');
  await deletePidFile(projectRoot);
}
```

**復旧方法**:
1. 古いPIDファイルを自動削除
2. 通常の起動フローを実行

#### 理由

- **ユーザー介入不要**: 異常終了後も自動で復旧
- **透明性**: 警告メッセージで状況を通知
- **安全性**: プロセスが既に停止していることを確認してから削除

#### トレードオフ

- **採用案の利点**:
  - ユーザー体験が良い（手動クリーンアップ不要）
  - 自動復旧で作業効率向上

- **不採用案**: 手動クリーンアップ要求
  - より安全（誤削除のリスクなし）
  - ユーザー体験が悪い

### 7. ポート管理戦略

#### 決定内容

**デフォルトポート**: `24280`

**ポート指定方法**:
- コマンドラインオプション: `--port <port>`
- 設定ファイル: `server.port`

**複数プロジェクト対応**:
- 各プロジェクトで異なるポートを使用
- ポート競合時はエラーで起動中止

**将来の拡張（未実装）**:
```typescript
// --port auto で空きポートを自動検索
const port = await findAvailablePort(24280, 24289);
```

#### 理由

- **デフォルト24280**: 一般的なサービスと競合しにくい
- **明示的なポート指定**: ユーザーが制御可能
- **競合時エラー**: 意図しない動作を防止

#### トレードオフ

- **採用案の利点**:
  - シンプルで予測可能
  - ユーザーが完全に制御

- **不採用案**: 自動ポート割り当て
  - ユーザーフレンドリー
  - 実装が複雑、デバッグしづらい

### 8. ヘルスチェック戦略

#### 決定内容

**2段階の生存確認**:

1. **プロセスレベル**: `process.kill(pid, 0)`
2. **アプリケーションレベル**: `GET /health`

```typescript
async function checkServerHealth(
  host: string,
  port: number,
  timeout: number = 3000
): Promise<boolean> {
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(timeout),
  });

  if (response.ok) {
    const data = await response.json();
    return data.status === 'ok';
  }

  return false;
}
```

#### 理由

- **プロセスレベル**: 高速、OS標準機能
- **アプリケーションレベル**: サーバが正常に応答しているか確認
- **タイムアウト設定**: 無限待機を防止

#### トレードオフ

- **採用案の利点**:
  - 包括的な確認
  - 障害の早期検出

- **不採用案**: プロセス生存確認のみ
  - シンプル
  - アプリケーションレベルの障害を検出できない

## 影響

### 実装への影響

- **ユーティリティ層の実装**: 3つの独立したユーティリティモジュール
  - `pid.ts`: PIDファイル操作
  - `process.ts`: プロセス管理
  - `project.ts`: プロジェクトルート管理

- **コマンド層の実装**: serverサブコマンド群
  - `server/start.ts`: 起動ロジック
  - `server/stop.ts`: 停止ロジック
  - `server/status.ts`: 状態確認ロジック

### ユーザー体験への影響

- **透明性**: 起動・停止の状態が明確
- **安全性**: 重複起動防止、異常終了からの自動復旧
- **柔軟性**: 複数プロジェクトで同時使用可能

### 保守性への影響

- **モジュール分離**: 責務が明確で拡張しやすい
- **テスタビリティ**: 各ユーティリティが独立してテスト可能
- **文書化**: 仕様書（server-process-management.md）で詳細に記録

## 代替案

### 検討した代替案

1. **グローバルなサーバ管理**
   - 全プロジェクトで1つのサーバプロセス
   - 却下理由: プロジェクトごとに設定が異なる、リソース管理が複雑

2. **pm2による管理**
   - 外部ツールpm2を使用
   - 却下理由: 外部依存、ユーザー環境への要求が増える

3. **systemd/launchdサービス**
   - OS標準のサービス管理機能を使用
   - 却下理由: クロスプラットフォーム対応が困難、設定が複雑

## 参考資料

- [Node.js process.kill() documentation](https://nodejs.org/api/process.html#process_process_kill_pid_signal)
- [Node.js child_process.spawn() documentation](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options)
- sebas-chanプロジェクトのプロセス管理実装

## 実装状況

- **実装完了**: 2025-10-28
- **コミット**: `2c30951 feat(cli): serverコマンド（start/stop/status）を実装`
- **テスト**: ビルド成功、lint成功、E2Eテスト通過

## 今後の拡張

1. **ログファイル出力**: デーモンモード時のログ保存
2. **自動ポート割り当て**: `--port auto` 対応
3. **プロセス監視**: 自動再起動機能（オプション）
4. **詳細なステータス**: CPU/メモリ使用量の表示
5. **クリーンアップコマンド**: 手動での古いPIDファイル削除（`server clean`）

---

**記録者**: Claude
**最終更新**: 2025-10-28

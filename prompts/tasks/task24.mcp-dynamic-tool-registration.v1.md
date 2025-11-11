# Task 24: MCP動的ツール登録の実装

## 作業日時
- 開始: 2025-11-11

## 目的
MCPサーバで`init`実行後に`server_start`などのツールが利用可能にならない問題を解決する。

## 問題の詳細

### 現状の動作
1. MCPサーバ起動時、システム状態を検出（NOT_CONFIGURED, CONFIGURED_SERVER_DOWN, RUNNING）
2. 検出した状態に応じて、一度だけツールを登録
3. `init`実行後、設定ファイルは作成されるが、ツールリストは更新されない
4. 結果：`server_start`などは呼び出せない

### コード箇所
- **packages/mcp-server/src/server.ts:171-199** - 起動時のツール登録
- **packages/mcp-server/src/tools/init.ts** - initツールの実装
- **packages/mcp-server/src/tools/server-control.ts** - server_start/stopツールの実装
- **packages/mcp-server/src/state.ts** - システム状態管理

### refreshSystemState()の制約
- `refreshSystemState()`は状態を更新するだけ
- **ツールの再登録は行わない**

## 調査結果

### MCP SDK API調査
- [x] 公式ドキュメントで動的ツール登録APIを確認
- [x] `@modelcontextprotocol/sdk`のAPIリファレンス
- [x] ツール登録解除のAPI有無
- [x] ツールリスト更新の通知方法

### 調査で判明した重要事項

#### registerTool()の戻り値
`registerTool()`は`RegisteredTool`型を返し、以下のメソッドを持つ：

```typescript
interface RegisteredTool {
  disable(): void;  // ツールを無効化
  enable(): void;   // ツールを有効化
  remove(): void;   // ツールを削除
}
```

#### 通知の自動送信
- ツールを`.disable()/.enable()/.remove()`すると、自動的に`notifications/tools/list_changed`が送信される
- クライアント側が対応していれば、ツールリストが自動更新される
- Claude Desktopは現時点でこの通知に対応していない（但し、Claude Codeがどうかは不明）

#### 実装の選択肢
1. **全ツールを登録し、状態に応じてenable/disableを切り替える** ← 推奨
2. 状態変化時に必要なツールのみ新規登録する

## 実装計画（詳細版）

### 基本方針
全ツールを起動時に登録し、システム状態に応じて`.enable()/.disable()`を切り替える。

### アーキテクチャ設計

#### 1. ツールハンドルの管理
```typescript
// src/server.ts
interface ToolHandles {
  init: RegisteredTool;
  serverStart: RegisteredTool;
  serverStop: RegisteredTool;
  systemStatus: RegisteredTool;
  search: RegisteredTool;
  getDocument: RegisteredTool;
  indexStatus: RegisteredTool;
}

const toolHandles: Partial<ToolHandles> = {};
```

#### 2. ツール登録関数の変更
各`register*Tool()`関数が`RegisteredTool`を返すように変更：

```typescript
// src/tools/init.ts
export function registerInitTool(context: ToolRegistrationContext): RegisteredTool {
  return context.server.registerTool('init', {...}, handler);
}
```

#### 3. ツール状態管理関数の追加
```typescript
// src/server.ts
function updateToolAvailability(state: SystemState, handles: Partial<ToolHandles>) {
  switch (state) {
    case 'NOT_CONFIGURED':
      handles.init?.enable();
      handles.systemStatus?.enable();
      handles.serverStart?.disable();
      handles.serverStop?.disable();
      handles.search?.disable();
      handles.getDocument?.disable();
      handles.indexStatus?.disable();
      break;

    case 'CONFIGURED_SERVER_DOWN':
      handles.init?.enable();
      handles.serverStart?.enable();
      handles.serverStop?.enable();
      handles.systemStatus?.enable();
      handles.search?.disable();
      handles.getDocument?.disable();
      handles.indexStatus?.disable();
      break;

    case 'RUNNING':
      // 全ツール有効
      Object.values(handles).forEach(h => h?.enable());
      break;
  }
}
```

#### 4. refreshSystemState()の拡張
```typescript
// src/server.ts
const refreshSystemState = async () => {
  const newState = await detectSystemState(cwd);
  Object.assign(systemState, newState);
  debugLog(`System state refreshed: ${systemState.state}`);

  // ツールの有効/無効を更新
  updateToolAvailability(systemState.state, toolHandles);
};
```

### 実装ステップ

#### Phase 1: 基盤実装
1. **ToolRegistrationContext型の拡張**
   - `RegisteredTool`を返すように各register関数を修正

2. **server.tsの改修**
   - `ToolHandles`型の定義
   - `toolHandles`変数の追加
   - 全ツールを起動時に登録（初期状態に応じてenable/disable）
   - `updateToolAvailability()`関数の実装
   - `refreshSystemState()`に`updateToolAvailability()`呼び出しを追加

3. **各ツールの戻り値修正**
   - `registerInitTool()`: `RegisteredTool`を返す
   - `registerServerStartTool()`: `RegisteredTool`を返す
   - `registerServerStopTool()`: `RegisteredTool`を返す
   - `registerSystemStatusTool()`: `RegisteredTool`を返す
   - `registerSearchTool()`: `RegisteredTool`を返す
   - `registerGetDocumentTool()`: `RegisteredTool`を返す
   - `registerIndexStatusTool()`: `RegisteredTool`を返す

#### Phase 2: テスト
4. **既存テストの確認**
   - `server-state.test.ts`が引き続き合格するか確認
   - ツール有効/無効の動作確認

5. **新規テストの追加**
   - init実行後にserver_startが利用可能になることを確認
   - server_start実行後にsearchが利用可能になることを確認
   - 状態遷移時のツールリスト変更を確認

#### Phase 3: ドキュメント
6. **ドキュメント更新**
   - README.mdに動的ツール登録の説明を追加
   - 各ツールの利用可能条件を明記

### 実装の詳細仕様

#### ツールの初期状態
起動時、検出したシステム状態に応じて、必要なツールのみ`.enable()`、それ以外は`.disable()`。

#### 状態遷移のタイミング
- `init`実行完了後
- `server_start`実行完了後
- `server_stop`実行完了後

#### エラーハンドリング
各ツールは既に状態チェックを実装しているため、disable状態でも実行時エラーメッセージで誘導可能（念のため）。

## MCP SDK 動的ツール登録 - 再利用可能な情報

このセクションは他のプロジェクトでも参照できるように情報源込みでまとめています。

### 基本概念

MCP SDK（`@modelcontextprotocol/sdk`）は、サーバ起動後にツールを動的に有効化/無効化/削除する機能を提供します。

### API仕様

#### registerTool()の戻り値

```typescript
interface RegisteredTool {
  disable(): void;  // ツールを一時的に無効化
  enable(): void;   // 無効化したツールを再有効化
  remove(): void;   // ツールを完全に削除
}

// 使用例
const myTool = server.registerTool('myTool', {
  description: 'My tool description',
  inputSchema: { /* ... */ }
}, async (args) => {
  // ツールのロジック
  return { content: [{ type: 'text', text: 'Result' }] };
});

// 後で状態を変更
myTool.disable();  // ツールを無効化
myTool.enable();   // ツールを再有効化
myTool.remove();   // ツールを削除
```

#### 自動通知

ツールの状態を変更（`.enable()/.disable()/.remove()`）すると、MCPサーバは自動的に`notifications/tools/list_changed`通知をクライアントに送信します。

#### クライアント側の対応

- **対応済み**: Visual Studio、一部のMCPクライアント
- **未対応**: Claude Desktop（2025-11時点）
- **Claude Code**: 実装後に確認が必要

対応しているクライアントは、この通知を受け取ると自動的にツールリストを再取得し、UIを更新します。

### 典型的な実装パターン

#### パターン1: 全ツール登録 + enable/disable切り替え（推奨）

```typescript
// 起動時に全ツールを登録
const toolHandles = {
  tool1: server.registerTool('tool1', {...}, handler1),
  tool2: server.registerTool('tool2', {...}, handler2),
  tool3: server.registerTool('tool3', {...}, handler3),
};

// 状態に応じて有効/無効を切り替え
function updateToolAvailability(state: string) {
  switch (state) {
    case 'STATE_A':
      toolHandles.tool1.enable();
      toolHandles.tool2.disable();
      toolHandles.tool3.disable();
      break;
    case 'STATE_B':
      toolHandles.tool1.enable();
      toolHandles.tool2.enable();
      toolHandles.tool3.disable();
      break;
    case 'STATE_C':
      Object.values(toolHandles).forEach(h => h.enable());
      break;
  }
}
```

**メリット**:
- シンプルで理解しやすい
- ツールの定義が一箇所に集約される
- 状態遷移ロジックが明確

#### パターン2: 動的登録/削除

```typescript
let currentTools: Map<string, RegisteredTool> = new Map();

function registerToolsForState(state: string) {
  // 既存ツールを削除
  currentTools.forEach(tool => tool.remove());
  currentTools.clear();

  // 状態に応じたツールを登録
  if (state === 'STATE_A') {
    currentTools.set('tool1', server.registerTool('tool1', {...}, handler1));
  } else if (state === 'STATE_B') {
    currentTools.set('tool1', server.registerTool('tool1', {...}, handler1));
    currentTools.set('tool2', server.registerTool('tool2', {...}, handler2));
  }
}
```

**メリット**:
- メモリ効率が良い（不要なツールハンドラを保持しない）

**デメリット**:
- 実装が複雑
- ツール定義が分散する可能性

### 情報源

#### 公式ドキュメント・リポジトリ
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **ソースコード**: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/refs/heads/main/src/server/mcp.ts
- **MCP仕様（Tools）**: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

#### コミュニティディスカッション
- **tools/list_changed通知の使用**: https://github.com/orgs/modelcontextprotocol/discussions/76
- **Visual Studio対応**: https://github.com/microsoft/vscode/issues/243944
- **Spring AI動的ツール更新**: https://spring.io/blog/2025/05/04/spring-ai-dynamic-tool-updates-with-mcp/

#### npm
- **パッケージ**: https://www.npmjs.com/package/@modelcontextprotocol/sdk

### 注意事項

1. **無効化されたツールの実行時エラー**
   - 無効化されたツールを呼び出そうとした場合の挙動は要確認
   - 念のため、各ツール内で状態チェックを実装することを推奨

2. **通知のデバウンシング**
   - 複数のツールを連続して変更する場合、通知が集約される可能性がある
   - SDK内部で処理されるため、開発者が意識する必要は少ない

3. **クライアント対応の確認**
   - 使用するクライアントが`notifications/tools/list_changed`に対応しているか確認
   - 未対応の場合、ユーザーにMCPサーバの再起動を促す必要がある

---

## 参考情報

### 関連ファイル
- packages/mcp-server/src/server.ts
- packages/mcp-server/src/state.ts
- packages/mcp-server/src/tools/*.ts
- packages/mcp-server/src/__tests__/server-state.test.ts

### 関連issue
（該当するissueがあれば記載）

## 進捗メモ
- 2025-11-11 午後: 問題調査完了、タスクメモ作成
- 2025-11-11 午後: MCP SDK API調査完了
  - `registerTool()`は`RegisteredTool`を返す（`.disable()/.enable()/.remove()`メソッド付き）
  - ツール状態変更時に自動的に`notifications/tools/list_changed`を送信
  - 全ツールを登録してenable/disableで制御する方針を決定
- 2025-11-11 午後: 実装計画の詳細化完了
- 2025-11-11 午後: Phase 1 実装完了
  - RegisteredTool型の定義
  - 各ツール登録関数の戻り値変更
  - server.tsでのツールハンドル管理と状態更新関数の実装
- 2025-11-11 午後: ビルド成功（型チェックOK）
- 2025-11-11 午後: Phase 2 テスト完了
  - 全40テストがパス
  - `[MCP] Tools list has changed`通知の送信を確認（動的ツール登録が正常動作）
- 2025-11-11 午後: Phase 3 ドキュメント更新完了
  - README.mdに動的ツール登録の説明を追加
  - システム状態とツールの対応表を作成
  - 各ツールの利用可能条件を明記

## 実装結果

### 成功した点
1. **すべてのテストがパス**: 既存テストとの互換性を維持
2. **通知の自動送信を確認**: MCP SDKが正しく`tools/list_changed`を送信
3. **型安全な実装**: TypeScriptの型推論を活用した堅牢な実装

### 確認事項
- ツールの状態変更時に`[MCP] Tools list has changed. Re-fetch tools list with listTools()`がstderrに出力される
- これはMCP SDKの正常な動作

### 今後の課題
- Claude Codeクライアント側の`notifications/tools/list_changed`対応状況の確認
  - 対応している場合: ツールリストが自動更新される
  - 未対応の場合: MCPサーバの再起動が必要（ユーザーに案内）

## 質問・不明点
- ~~MCP SDKの動的ツール登録APIの詳細~~ → 解決
- ~~ツール登録解除が必要か、上書き登録で十分か~~ → enable/disable方式を採用
- ~~ツールリスト更新時のクライアント側の挙動~~ → 自動通知される
- Claude Codeの対応状況 → 実運用で確認が必要

---

**作業ステータス**: 完了 ✅
**優先度**: 高（ユーザーエクスペリエンスに直結）
**実績工数**: 約1.5時間（Phase 1: 45分、Phase 2: 15分、Phase 3: 30分）

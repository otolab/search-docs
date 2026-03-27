# task30: server.log 肥大化対策（ログローテーション）

## 状況
- `.search-docs/server.log` が134MB/41万行まで肥大化
- 原因の98%はPythonワーカーのパフォーマンスログ（1秒間隔JSON出力）
- stderrBufferに蓄積 → exit時ダンプで爆発的増大
- ログローテーション機能なし

## 作業計画

### Step 1: パフォーマンスログのstderrBuffer蓄積停止
- `packages/db-engine/src/typescript/index.ts`
- パフォーマンスログ行をstderrBufferに蓄積しない

### Step 2: RotatingWriteStream実装
- `packages/server/src/utils/rotating-log.ts` 新規
- 1MB / 3世代

### Step 3: サーバプロセスでのログ管理
- `bin/server.ts` でconsole override
- `process.ts` でstdioをignoreに変更
- `start.ts` でlogPath伝達（env変数経由）

### Step 4: 検証
- ビルド・テスト通過確認
- ログローテーション動作確認

## 作業ログ
- 2026-03-27: 作業開始

# task25 - DBエンジン・Pythonインターフェイス整理計画 (v1)

## 背景
- docs/implementation-details.md のJSON-RPCメソッド一覧が実装と乖離しており、IndexRequest関連や getSectionById などが未掲載
- TypeScript側では sendRequest の呼び出しと camelCase→snake_case 変換が各メソッドに散在し、メソッド名の更新漏れリスクが高い
- Pythonワーカーは if/elif 連鎖でメソッドをディスパッチしており、インターフェイス変更時に双方の同期が難しい
- 仕様と実装の単一ソース化ができておらず、ドキュメント自動更新の仕組みも不在

## 目的
1. JSON-RPCメソッド/引数/戻り値の一覧を最新の実装に追随させ、メンテナンス性を確保する
2. TypeScriptとPythonで共通のメソッド定義を参照できる構造を整備し、手動同期をなくす
3. パラメータ変換やエラーハンドリングを共通化して、コード重複と不整合を減らす
4. 将来的に自動ドキュメント生成やコード生成に繋げられる基盤を整える

## 計画
1. **現状棚卸しと仕様表の更新**
   - packages/db-engine/src/typescript/index.ts, packages/db-engine/src/python/worker.py からRPCメソッド・パラメータを洗い出し
   - docs/implementation-details.md に最新のメソッド一覧・SearchOptions拡張項目（offset, includePaths 等）を反映
   - IndexRequest関連メソッドとレスポンス形式も表形式で追加
2. **RPCメソッド定義の単一ソース化**
   - `packages/types` か `packages/db-engine` 配下に `rpc-methods.ts` のような定数/型を新設
   - TypeScript側の sendRequest 呼び出しを enum/const 参照に切り替え
   - Python側でも同一リストを参照できるよう、生成スクリプトや共有JSONを検討
3. **パラメータ変換ユーティリティの導入**
   - camelCase↔snake_case 変換ロジックを共通ヘルパーに切り出し、DBEngineメソッドから削除
   - ネスト構造（filter/updates）にも適用できるよう汎用的に設計
4. **Pythonワーカーのディスパッチ整理**
   - if/elif 連鎖を `METHOD_HANDLERS = {'ping': self.ping, ...}` 形式へリファクタリング
   - 未対応メソッド検出・ロギングを統一し、パフォーマンスロガーとの連携も整理
5. **検証と自動テスト**
   - TypeScript側は既存Vitestを拡張し、enum/ユーティリティ導入による挙動を確認
   - Python側もユニットテスト/統合テストを追加し、dispatchリファクタの動作を担保
   - ドキュメントとの差分チェック（例: 生成JSONとdocsの比較）もタスク化

## 懸念・フォローアップ
- RPC定義をどこで共有するか要検討（Node/Python間での共有フォーマット: JSON/Schemaなど）
- 自動ドキュメント生成まで踏み込む場合は追加タスク化
- 既存クライアント（CLI/MCP）への影響度を確認し、必要ならアップデート手順を追記

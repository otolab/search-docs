# task33: packages/agent 設計

## 概要

Chroma Context-1モデル（mlx-community/context-1-MLX-4bit）をMlxDriverで動かし、search-docsのツール群を与えるマルチホップ検索エージェントパッケージの設計。

## 背景

- Context-1: 20B MoEモデル、検索タスク特化のRL訓練済み
- 「質問→概念分解→並列ツール呼び出し→pruning→関連文書出力」のエージェントループが重みに焼き込まれている
- エージェントハーネスは未公開だが、chat_template.jinjaからプロンプト形式を解析済み

## 設計成果

詳細な設計は `.claude/plans/witty-wiggling-breeze.md` に記載。

### 主要な設計判断

1. **LLMバックエンド**: `@modular-prompt/driver`のMlxDriverでcontext-1をローカル実行
2. **エージェントループ**: `@modular-prompt/process`の`toolAgentProcess`に委譲（自前ループなし）
   - PR #196で handler にcontext渡し＋毎ターンre-compileが追加済み
3. **ツール**: search, get_document, get_outline, prune の4つ
   - pruneはcontext.chunks/messagesを直接操作 → 次のcompileでプロンプトから消える
4. **プロンプト形式**: context-1固有の特殊トークン + TypeScript namespace形式のツール定義
   - MlxDriverがchat_templateを自動読み込み、roleの拡張不要
5. **パッケージの役割**: ツール定義・コンテキスト型・プロンプト・実験環境を提供

### Context-1プロンプト形式の重要な発見

- チャネルシステム: analysis（思考）、commentary（ツール）、final（最終出力）
- ツール呼び出し: `<|start|>assistant to=functions.name<|channel|>commentary json<|message|>{args}<|call|>`
- ツール結果: `<|start|>functions.name to=assistant<|channel|>commentary<|message|>"result"<|end|>`
- systemロール → テンプレートがdeveloperに自動変換

### パッケージ構成

```
packages/agent/
├── src/
│   ├── run.ts          # runSearchAgent() ファサード
│   ├── tools.ts        # ToolSpec<SearchAgentContext>[]
│   ├── context.ts      # SearchAgentContext, Chunk型
│   ├── prompt.ts       # PromptModule<SearchAgentContext>
│   └── parse.ts        # output → RetrievedDocument[] パーサ
├── tests/
│   └── integration/    # TestDriver使用のインテグレーションテスト
└── experiments/        # context-1 / Sonnet 比較実験
```

## ステータス

- [x] Context-1の技術調査
- [x] chat_template.jinjaの解析
- [x] MlxDriverの互換性確認
- [x] パッケージ設計（型定義、ファイル構成）
- [x] toolAgentProcess拡張（modular-prompt PR #196）
- [ ] 実装（次セッション）

## 次のステップ

1. packages/agent/ のスキャフォールド作成
2. context.ts（SearchAgentContext, Chunk型）
3. tools.ts（ToolSpec[] — search/get_document/get_outline/prune）
4. prompt.ts（PromptModule）
5. run.ts（runSearchAgent ファサード）
6. parse.ts（出力パーサ）
7. experiments/ でcontext-1実行テスト

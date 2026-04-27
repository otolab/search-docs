# task42: CoreML GPU ディスパッチ修正

## 背景

PyTorch → ONNX Runtime 移行後、Apple Silicon の GPU 利用率が 0% にデグレード。
CoreML EP に 599 ノード委譲されるが、全て MLCPUComputeDevice にフォールバックしていた。

## 原因

ONNX モデルの入力が動的形状（`batch_size`, `sequence_length`）で宣言されているため、CoreML が GPU 用の静的コンパイルを実行できない。

## 解決策

`SessionOptions.add_free_dimension_override_by_name()` でセッション作成時に固定長を指定。
3つのバケットサイズ [64, 2048, 8192] でセッションを分け、入力長に応じて選択する。

### CoreML プロバイダオプション

- `ModelFormat: MLProgram` — GPU ディスパッチに必須
- `MLComputeUnits: ALL` — GPU/ANE/CPU 全てを許可
- `AllowLowPrecisionAccumulationOnGPU: 1` — FP16 アキュムレーション許可
- `RequireStaticInputShapes: 1` — 静的ノードのみ CoreML に渡す
- `SpecializationStrategy: FastPrediction` — 推論レイテンシ優先

## 検証結果

- ProfileComputePlan: 599/599 ノードが `MLGPUComputeDevice: Apple M4 Max`
- エンコード動作: 短いクエリ、中テキスト、バッチ処理いずれも 256 次元ベクトル正常出力
- 既存テスト: 41 件全パス

## 変更ファイル

- `packages/db-engine/src/python/embedding_onnx.py` — CoreML バケットセッション対応

## 注意

- CoreML パスはローカル実行専用（Apple Silicon）
- Docker 環境は CUDA/CPU パスを使用（変更なし）

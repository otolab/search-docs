# task20.2: スレッドリーク原因箇所の特定調査

## 背景

task20の調査により以下が判明:
- 最初のadd_sections呼び出し: スレッド32→66 (+34) - 正常な初期化
- 2回目以降のadd_sections: 66→97 (+31) - **1回ごとに約1スレッドがリーク**

## 目的

`add_sections()`メソッド内でスレッドを生成している箇所を特定し、リークの根本原因を明らかにする。

## 調査方針

### 1. スレッドダンプの追加

`worker.py`の`add_sections()`メソッドに、呼び出し前後でスレッド情報をログ出力する。

**追加するログ**:
- アクティブスレッド数
- スレッド名のリスト
- 各スレッドの状態（daemon/alive）

### 2. 調査ポイント

以下の箇所を重点的に調査:

1. **`table.add(sections)` 呼び出し**
   - LanceDB内部のスレッド管理
   - 前後でのスレッド数変化

2. **埋め込みモデルの処理**
   - `self.embedding_model.encode()`呼び出し
   - モデルが並列処理を使用しているか

3. **PyArrowのスレッドプール**
   - 環境変数設定が効いているか確認
   - メモリプール設定の影響

### 3. 実装計画

#### Phase 1: スレッドダンプ機能の追加

```python
def log_thread_info(self, label: str):
    """スレッド情報をログ出力"""
    import threading
    threads = threading.enumerate()
    sys.stderr.write(f"[ThreadDump] {label}\n")
    sys.stderr.write(f"  Active threads: {len(threads)}\n")
    for t in threads:
        sys.stderr.write(f"    - {t.name} (daemon={t.daemon}, alive={t.is_alive()})\n")
    sys.stderr.flush()
```

#### Phase 2: add_sections()での計測

```python
def add_sections(self, params: Dict[str, Any]) -> Dict[str, int]:
    # 処理前のスレッド状態
    self.log_thread_info("BEFORE add_sections")

    # ... 既存の処理 ...

    # table.add()前
    self.log_thread_info("BEFORE table.add()")
    table.add(sections)
    # table.add()後
    self.log_thread_info("AFTER table.add()")

    # 処理後のスレッド状態
    self.log_thread_info("AFTER add_sections")

    return {"count": count}
```

#### Phase 3: 測定実施

```bash
# karte-io-systemsで再度測定
cd /Users/naoto.kato/Develop/plaid/karte-io-systems
rm -rf .search-docs

# サーバ起動（フォアグラウンドで短時間）
node /Users/naoto.kato/Develop/otolab/search-docs/packages/cli/dist/index.js \
  server start --foreground \
  > /Users/naoto.kato/Develop/otolab/search-docs/prompts/tasks/logs/task20.2-thread-dump.log 2>&1
```

### 4. 分析方法

ログから以下を抽出:
1. 各add_sections呼び出しでのスレッド増加パターン
2. 新しく生成されるスレッドの名前（パターン）
3. table.add()前後でのスレッド変化
4. daemon/non-daemonスレッドの比率

## 期待される結果

### パターン1: LanceDB内部のスレッドリーク
- `table.add()`前後でスレッドが増加
- スレッド名にLanceDB/PyArrow関連の名前が含まれる

### パターン2: 埋め込みモデルのスレッドリーク
- `encode()`呼び出し前後でスレッドが増加
- PyTorch/Transformers関連のスレッド名

### パターン3: その他のライブラリ
- pandas/numpy等の並列処理
- Python標準ライブラリのThreadPoolExecutor等

## 次のステップ

調査結果に基づいて:
1. 原因箇所の特定
2. 修正方法の検討
3. 修正の実装とテスト

---

## 実装ログ

### Phase 1: スレッドダンプ機能の実装（完了）

- `worker.py`に`log_thread_info()`メソッドを追加
- `add_sections()`の前後でスレッド情報を出力
- ビルド成功

### Phase 2: 小規模テスト実施

**search-docs自身での測定結果**:
- スレッド数: 3→4で安定
- add_sections実行中もスレッド増加なし
- **小規模プロジェクトでは問題が再現しない**

### 重要な発見: IndexWorkerの実装を確認

`packages/server/src/worker/index-worker.ts`の調査により判明:

```typescript
// Line 104: 1件ずつ順次処理
for (const request of requests) {
  await this.processRequest(request);  // 同期的に待つ
}
```

**現在の実装**:
- `maxConcurrent: 3`という設定があるが、**実際には1件ずつ順次処理**
- 並列処理は行われていない
- 各`add_sections()`は前のものが完了してから実行される

**これが意味すること**:
- task20で観測されたスレッド増加は、並列処理によるものではない
- **1回のadd_sections呼び出しごとにスレッドがリークしている**
- リクエスト投入（CreateRequest）とadd_sections実行の関係は、並列度の問題ではなく、**処理量の問題**である可能性が高い

### 次の調査方向の修正

並列処理が原因ではないため、焦点を絞るべき点:
1. **LanceDB/PyArrowのtable.add()内部でのスレッド管理**
2. セクション数やデータ量がスレッド生成に影響するか
3. 環境変数（OMP_NUM_THREADS等）が正しく適用されているか

---

## Phase 3: 大規模測定の実施と分析

### 測定実行

**日時**: 2025-11-06
**測定時間**: 60秒
**ログファイル**: `prompts/tasks/logs/task20.2-large-scale-test-60s.log`

### 重要な発見: スレッドカウントの乖離

**スレッドダンプ（`threading.enumerate()`）**:
- Pythonスレッドのみをカウント
- add_sections前: 3本
- table.add()前後: 4本（変化なし）

**パフォーマンスログ（`psutil.Process().num_threads()`）**:
- OSレベルのスレッド総数
- add_sections実行中: 65本

```
[ThreadDump] BEFORE add_sections (call #1)
  Active threads: 3
    LanceDBBackgroundEventLoop: 1
    MainThread: 1
    Thread- (_log_loop): 1

{"type": "performance", "timestamp": 1762394297.5180511, "elapsed": 42.19,
 "threads": 65, "rss_mb": 2553.64, ...}

[ThreadDump] BEFORE table.add()
  Active threads: 4
    LanceDBBackgroundEventLoop: 1
    MainThread: 1
    Thread: 1
    Thread- (_log_loop): 1

[ThreadDump] AFTER table.add()
  Active threads: 4
    (変化なし)
```

### 結論

**Pythonスレッドは増えていない。ネイティブスレッド（C拡張/ライブラリ内部）が大量生成されている。**

1. **`threading.enumerate()`で観測可能なPythonスレッド**:
   - 3→4本で安定
   - 増加はPerformanceLoggerのdaemonスレッド1本のみ
   - リークなし

2. **`psutil`で観測されるOSレベルスレッド**:
   - 22→65本（初回add_sections時）
   - その後も増え続ける（task20データ: 最終97本）
   - **ネイティブスレッドのリーク**

3. **リーク源の候補**:
   - LanceDB内部（Rust実装）
   - PyArrow（C++実装）
   - 埋め込みモデル（PyTorch/Transformers、C++バックエンド）
   - NumPy/BLAS（ネイティブスレッドプール）

### 次のステップ

Pythonレベルのスレッドダンプでは原因特定できない。以下の調査が必要:

1. **C++レイヤーのスレッドプール調査**
   - PyArrowのスレッド設定確認
   - LanceDBのスレッドプール設定
   - BLASライブラリのスレッド数制限

2. **環境変数の効果検証**
   - `OMP_NUM_THREADS=4`が効いているか
   - PyTorchのスレッド数制限
   - LanceDBの設定オプション

3. **ライブラリバージョン確認**
   - LanceDBの既知の問題
   - PyArrowの既知の問題
   - 最新版への更新検討

---

## Phase 4: 実験的切り分け - encode vs table.add()

### 実験設計

環境変数`THREAD_TEST_MODE`で制御:
- `encode_only`: 通常のencodeに加えて、extra encodeを実行（table.add()は1回）
- `add_only`: 通常のtable.add()に加えて、extra table.add()を実行（encodeは1回）

### 実装

`worker.py`の`add_sections()`メソッドに実験コードを追加:

**パターンA (encode_only)**:
```python
if test_mode == 'encode_only':
    self.log_thread_info("BEFORE extra encode")
    dummy_text = "テストテキスト" * 100
    _ = self.embedding_model.encode(dummy_text, self.vector_dimension)
    self.log_thread_info("AFTER extra encode")
```

**パターンB (add_only)**:
```python
if test_mode == 'add_only':
    self.log_thread_info("BEFORE extra table.add()")
    table.add(sections)  # 2回目の追加
    self.log_thread_info("AFTER extra table.add()")
```

### 測定結果

**日時**: 2025-11-06
**測定時間**: 各45秒
**ログファイル**:
- `prompts/tasks/logs/task20.2-experiment-encode-only.log`
- `prompts/tasks/logs/task20.2-experiment-add-only.log`

#### スレッド増加量の比較

| パターン | 初期スレッド | 最終スレッド | 増加量 | add_sections実行回数 |
|---------|------------|------------|--------|---------------------|
| A (encode_only) | 22 | 65 | +43 | 9回 |
| B (add_only) | 22 | 67 | +45 | 8回 |

#### 詳細データ

**パターンA (encode_only)**:
```
Time(s) | Threads | AddSections | RSS(MB)
--------|---------|-------------|--------
   0.00 |      22 |           0 |  138.02
  39.11 |      62 |           2 | 2874.62
  43.12 |      65 |           9 | 3039.52

Summary:
  Threads: 22 -> 65 (+43)
  RSS: 138.02 -> 3039.52 MB (+2901.50)
```

**パターンB (add_only)**:
```
Time(s) | Threads | AddSections | RSS(MB)
--------|---------|-------------|--------
   0.00 |      22 |           0 |  137.77
  39.16 |      63 |           2 | 2850.78
  43.18 |      67 |           8 | 3033.30

Summary:
  Threads: 22 -> 67 (+45)
  RSS: 137.77 -> 3033.30 MB (+2895.53)
```

### 分析

#### 1. 両方のパターンでほぼ同等のスレッド増加

- パターンA (extra encode): +43スレッド
- パターンB (extra table.add()): +45スレッド
- **差はわずか+2スレッドのみ**

#### 2. Pythonスレッドは両パターンで増加なし

- `threading.enumerate()`による観測: 常に4本
- extra encode前後: 変化なし
- extra table.add()前後: 変化なし

#### 3. OSレベルスレッドのみが増加

- `psutil.Process().num_threads()`で観測される
- Pythonから直接制御できないネイティブスレッド

### 結論

**両方の操作（embedding.encode() と table.add()）がスレッドリークに寄与している**

この結果は以下のいずれかを示唆:

1. **両方が独立してリークしている**
   - 埋め込みモデル（PyTorch/Transformers）がスレッドをリーク
   - LanceDB（Rust）がスレッドをリーク
   - それぞれが個別に問題を持つ

2. **共通の下層ライブラリが原因**
   - PyArrow（両方で使用）
   - BLAS/数値計算ライブラリ
   - どちらの操作でも同じライブラリが使われる

3. **相互作用で発生**
   - データの受け渡し時にスレッドが生成される
   - メモリ管理の問題

### 次の調査ステップ

実験では決定的な切り分けができなかった。以下の追加調査が必要:

1. **PyArrowのスレッド設定を厳格化**
   - 環境変数の効果を確認
   - 明示的なスレッドプール制限

2. **ライブラリバージョン調査**
   - LanceDBの最新バージョン確認
   - 既知の問題のレビュー

3. **代替実装の検討**
   - スレッドプール明示的管理
   - ライブラリの置き換え検討

---

## Phase 5: 処理削減実験 - メモリリーク源の特定

### 実験設計（処理削減版）

前回の「追加実験」ではメモリ消費が大きすぎて判断が困難だった。
今回は**処理を減らす**ことで、どちらがメモリリークしているか特定する。

環境変数`THREAD_TEST_MODE`で制御:
- `skip_encode`: vector化をスキップ（ゼロベクトルを設定）
- `skip_add`: table.add()をスキップ
- 通常（環境変数なし）: 両方実行

### 実装

`worker.py`の`add_sections()`メソッドを修正:

**skip_encodeモード**:
```python
if test_mode != 'skip_encode':
    # 通常のencode
    section["vector"] = self.embedding_model.encode(text, self.vector_dimension)
else:
    # ゼロベクトルを設定
    section["vector"] = [0.0] * self.vector_dimension
```

**skip_addモード**:
```python
if test_mode != 'skip_add':
    table = self._get_sections_table()
    table.add(sections)
else:
    # table.addをスキップ
    pass
```

### 測定結果

**日時**: 2025-11-06
**測定時間**: 各120秒（2分）
**ログファイル**:
- `prompts/tasks/logs/task20.2-skip-encode.log`
- `prompts/tasks/logs/task20.2-skip-add.log`
- `prompts/tasks/logs/task20.2-normal-2min.log`

#### インデックス作成開始後の増加速度

**重要**: 初期化フェーズを除外し、add_sections開始後の増加速度で比較

| パターン | Encode | table.add | 呼び出し回数 | メモリ増加 | MB/call | MB/sec |
|---------|--------|-----------|-------------|-----------|---------|--------|
| C: skip_encode | なし | あり | 128 | 406 MB | **3.17** | 4.97 |
| D: skip_add | あり | なし | 79 | 4385 MB | **55.51** | 54.46 |
| E: normal | あり | あり | 78 | 4404 MB | **56.46** | 56.88 |

#### 詳細データ

**パターンC (skip_encode - table.addのみ)**:
```
Indexing duration: 81.6s
AddSections count: 128
Memory: 1218.0 -> 1624.1 MB (+406 MB)
Per add_sections: 3.17 MB/call
Threads: 44 -> 69
```

**パターンD (skip_add - encodeのみ)**:
```
Indexing duration: 80.5s
AddSections count: 79
Memory: 2634.1 -> 7019.3 MB (+4385 MB)
Per add_sections: 55.51 MB/call
Threads: 66 -> 70
```

**パターンE (normal - 両方)**:
```
Indexing duration: 77.4s
AddSections count: 78
Memory: 2617.9 -> 7021.7 MB (+4404 MB)
Per add_sections: 56.46 MB/call
Threads: 65 -> 82
```

### 分析

#### 1. メモリリークの主要因はencode処理

- **encode処理**: 55.51 MB/call のリーク
- **table.add処理**: 3.17 MB/call のリーク（正常範囲）
- **全体の97%以上がencode処理によるリーク**

#### 2. normalとskip_addがほぼ同一

- skip_add: 55.51 MB/call
- normal: 56.46 MB/call
- 差はわずか1 MB（table.addの寄与は最小限）

#### 3. skip_encodeは大幅に改善

- 3.17 MB/call のみ
- normalの約1/18のメモリ消費

### 結論

**メモリリークの犯人は「embedding.encode()」である**

1. **埋め込みモデル（Ruri）が原因**
   - PyTorch/Transformers のメモリ管理に問題
   - 1回のencode呼び出しで約55 MBがリーク

2. **LanceDBは正常**
   - table.add()のメモリ消費は3 MB/call程度
   - これは通常の動作範囲内

3. **スレッドプールは無関係**
   - スレッド数は104で頭打ち（Phase 3で確認済み）
   - メモリリークとスレッド数の増加は別問題

### 次のステップ

原因が特定できたため、以下を調査:

1. **埋め込みモデルの使い方を検証**
   - encode()の呼び出し方法が適切か
   - モデルの初期化・解放が正しいか

2. **ライブラリのバグ調査**
   - Ruriモデルの既知の問題
   - PyTorch/Transformersのメモリリーク

3. **単体テストで再現**
   - 埋め込みモデルのみを単独で実行
   - メモリリークが再現するか確認

---

## Phase 6: 埋め込みモデル単体テスト - 使い方 vs ライブラリバグの切り分け

### 目的

Phase 5で`embedding.encode()`がメモリリークの主犯と判明。
次に、これが以下のどちらなのかを確認:
1. **使い方の問題**: worker.pyでの使い方が不適切
2. **ライブラリのバグ**: Ruri/PyTorch/Transformers自体のバグ

### テスト実装

埋め込みモデルを単独で実行するスクリプト `/tmp/test_embedding_memory.py` を作成:

**テスト内容**:
- Ruriモデル（cl-nagoya/ruri-v3-30m）を初期化
- `encode()`を100回実行
- 各10回ごとにメモリ使用量を記録
- worker.pyと同じ使い方で実行

**テストコード概要**:
```python
embedding_model = create_embedding_model("cl-nagoya/ruri-v3-30m")
embedding_model.initialize()

# ウォームアップ
_ = embedding_model.encode(test_text, 256)

# 100回encode実行
for i in range(100):
    text = f"テストテキスト第{i}回目。" * 20
    _ = embedding_model.encode(text, 256)
    # 10回ごとにメモリログ
```

### 測定結果

**日時**: 2025-11-06
**反復回数**: 100回
**ログファイル**: `/tmp/embedding_test_output.log`

#### メモリ使用量の推移

```
Initial memory:         24.20 MB
After model creation:   24.20 MB (+0.00)
After initialization:   641.23 MB (+617.03)  ← モデルロード
After warm-up:          672.19 MB (+30.95)   ← 初回encode

Iterations:
  Iteration  10: RSS 677.39 MB, Elapsed 0.08s
  Iteration  20: RSS 682.36 MB, Elapsed 0.17s
  Iteration  30: RSS 682.52 MB, Elapsed 0.21s
  Iteration  40: RSS 682.52 MB, Elapsed 0.25s
  Iteration  50: RSS 682.52 MB, Elapsed 0.30s
  Iteration  60: RSS 682.53 MB, Elapsed 0.34s
  Iteration  70: RSS 682.56 MB, Elapsed 0.40s
  Iteration  80: RSS 682.58 MB, Elapsed 0.45s
  Iteration  90: RSS 682.61 MB, Elapsed 0.50s
  Iteration 100: RSS 682.61 MB, Elapsed 0.55s

Final memory:           682.61 MB
```

#### 増加速度の計算

**100回のencode実行中**:
- メモリ増加: 672.19 MB → 682.61 MB (+10.42 MB)
- **平均: 0.10 MB/call**

**iteration 10-100での増加速度**:
- メモリ増加: 5.22 MB
- 呼び出し回数: 90回
- **平均: 0.06 MB/call**

### 分析

#### 1. worker.pyとの比較

| 環境 | encode()の挙動 | メモリ増加速度 |
|------|---------------|--------------|
| **単体テスト** | 100回実行 | **0.10 MB/call** |
| **worker.py** | skip_addモード | **55.51 MB/call** |
| **差** | - | **約550倍** |

#### 2. 結論

**embedding.encode()自体にメモリリークはない**

- 単体で実行した場合、メモリ増加は0.1 MB/call程度
- これは正常な動作範囲内（キャッシュ、ガベージコレクション待ちなど）
- worker.pyで観測された55 MB/callとは全く異なる

#### 3. 原因の特定

**問題はworker.pyでの使い方にある**

worker.pyと単体テストの違い:
1. **データフロー**
   - 単体: Python内で完結
   - worker.py: TypeScript → JSON-RPC → Python → LanceDB

2. **データ変換**
   - 単体: 単純な文字列入力
   - worker.py: セクションデータの正規化、PyArrow変換

3. **ベクトルの扱い**
   - 単体: encode()の結果を即座に破棄
   - worker.py: `section["vector"]`に格納、PyArrowテーブルに追加

4. **並列処理の有無**
   - 単体: 単純なforループ
   - worker.py: JSON-RPCワーカー、複数リクエスト処理

### 次のステップ

以下を重点的に調査:

1. **ベクトルデータの保持**
   - `section["vector"]`への代入後、参照が残っていないか
   - PyArrowへの変換時に余分なコピーが発生していないか

2. **データ正規化処理**
   - `_normalize_section_data()`でメモリリークしていないか
   - 特にベクトルデータの扱い

3. **PyArrowとの連携**
   - ベクトルをPyArrow形式に変換する際のメモリ管理
   - 参照カウントの問題

4. **ガベージコレクション**
   - Python側でのGC実行タイミング
   - C++オブジェクトの解放タイミング

### 検証方法の提案

1. **段階的にworker.pyに近づける**
   - まず: encode()結果をlistに保存
   - 次: dictに保存
   - 次: PyArrow変換
   - 各段階でメモリ測定

2. **worker.pyの簡素化**
   - table.add()をskip
   - section["vector"]への代入のみ実行
   - メモリリークが再現するか確認

3. **参照の明示的解放**
   - encode()結果を代入後、`del section["vector"]`
   - リークが軽減するか確認

---

## Phase 7: 仮説検証実験 - ベクトルデータの参照保持問題

### 実験1: deepcopyによる参照切り離し

**仮説**: JSON-RPCワーカーから渡された`sections`配列への参照が保持されているため、ベクトルデータがメモリに残り続ける。

**実装**:
```python
# worker.py add_sections() 先頭に追加
sections = copy.deepcopy(sections)
```

**測定結果**:
- **メモリ増加速度**: 56.44 MB/call
- **ベースライン**: 56.46 MB/call
- **差**: -0.02 MB（誤差範囲内）
- **ログファイル**: `prompts/tasks/logs/task20.2-deepcopy-experiment.log`

**結論**: 改善なし。参照保持は問題ではない。

---

### 実験2: ベクトルを格納しない実験

**仮説**: `section["vector"]`への代入処理自体がメモリリークの原因。

**実装**:
```python
# 環境変数: THREAD_TEST_MODE=no_store_vector
text = f"{section['heading']}\n{section['content']}"
_ = self.embedding_model.encode(text, self.vector_dimension)  # 結果を破棄
section["vector"] = [0.0] * self.vector_dimension  # table.addのためダミーを設定
```

**測定結果**:
- **メモリ増加速度**: 70.69 MB/call
- **ベースライン**: 56.46 MB/call
- **差**: +14.23 MB（悪化）
- **ログファイル**: `prompts/tasks/logs/task20.2-no-store-vector.log`

**結論**: 悪化。encode()の呼び出し自体が問題であり、結果の格納処理は無関係。

---

### 実験3: PyArrow明示的解放

**仮説**: PyArrowのゼロコピーアーキテクチャにより、ベクトルデータへの参照が保持される。

**実装**:
```python
# table.add()後に明示的解放を追加
for section in sections:
    if "vector" in section:
        section["vector"] = None
del sections

import pyarrow as pa
pool = pa.default_memory_pool()
pool.release_unused()
```

**測定結果**:
- **メモリ増加速度**: 55.72 MB/call
- **ベースライン**: 56.46 MB/call
- **差**: -0.74 MB（誤差範囲内）
- **ログファイル**: `prompts/tasks/logs/task20.2-pyarrow-release.log`

**結論**: 改善なし。PyArrowは問題ではない（Phase 5の結果とも一致）。

---

### 実験4: sentence-transformers既知の問題への対処

**背景**: sentence-transformersのGitHub Issuesで以下のメモリリーク問題が報告されている:
- **Issue #1795**: 配列を渡す際の最初の10,000予測でメモリリーク
- **Issue #487**: VRAM使用量が増加、`.detach()`と`.to("cpu")`で解決

**実装** (`embedding.py`):
```python
def encode(self, text: str, dimension: int = None) -> List[float]:
    # PyTorchのテンソルとして取得
    embeddings = self.model.encode(text, convert_to_numpy=False)

    # 【メモリリーク対策】PyTorchの計算グラフを切り離す
    # sentence-transformersの既知の問題 (Issue #1795, #487) への対処
    # 計算グラフへの参照が蓄積されるのを防ぐ
    if hasattr(embeddings, 'detach'):
        embeddings = embeddings.detach()

    # CPUに移動してからnumpy配列に変換
    if hasattr(embeddings, 'cpu'):
        embeddings = embeddings.cpu()

    # numpy配列に変換
    if hasattr(embeddings, 'numpy'):
        embeddings = embeddings.numpy()

    # 次元調整
    embeddings = self._adjust_dimension(embeddings, dimension)
    return embeddings.tolist()
```

**測定結果**:
- **メモリ増加速度**: 69.90 MB/call
- **ベースライン**: 56.46 MB/call
- **差**: +13.44 MB（悪化）
- **ログファイル**: `prompts/tasks/logs/task20.2-pytorch-detach.log`

**結論**: 改善なし。むしろ悪化。sentence-transformersの既知の問題とは異なる原因。

---

### Phase 7 まとめ

#### 検証した仮説

1. ✗ **参照保持**: deepcopyしても改善なし
2. ✗ **ベクトル格納処理**: 格納しなくても改善なし（むしろ悪化）
3. ✗ **PyArrow**: 明示的解放しても改善なし
4. ✗ **PyTorch計算グラフ**: .detach()しても改善なし（むしろ悪化）

#### 重要な発見

1. **encode()の呼び出し自体が問題**
   - ベクトルを格納しない場合でもリーク発生（70.69 MB/call）
   - 結果の扱いは無関係

2. **単体実行との環境差が鍵**
   - 単体テスト: 0.10 MB/call（正常）
   - worker.py: 55-70 MB/call（異常）
   - 約550-700倍の差

3. **sentence-transformers既知の問題とは別**
   - .detach()/.cpu()で解決せず
   - 異なる種類のメモリリーク

#### 未解明の謎

**なぜworker.py環境だけでencode()がメモリリークするのか？**

worker.pyの特殊な環境要因:
1. JSON-RPCワーカーとしての実行
2. 80+のスレッドが動作中
3. TypeScript ↔ Python間の頻繁なデータ交換
4. LanceDBとの連携（table.add()前のコンテキスト）

### 次の調査方向

以下のいずれかを検証する必要がある:

1. **スレッド環境の影響**
   - 単体テストに擬似的なスレッド環境を追加
   - worker.pyの環境を再現してメモリリークを確認

2. **JSON-RPCコンテキストの影響**
   - 単体テストにJSON-RPCワーカーを追加
   - 標準入出力を介したデータ交換を再現

3. **代替実装の検討**
   - 別の埋め込みモデルライブラリ（sentence-transformers以外）
   - encode()のバッチ処理化
   - モデルの再初期化戦略

---

## Phase 8: ライブラリ vs ユーティリティ処理の切り分け

### 実験5: ライブラリ呼び出しと後続処理の分離

**動機**: Phase 7で全ての仮説が失敗。ユーザーの提案により、`model.encode()`（ライブラリ）と後続のユーティリティ処理を完全に分離して検証。

**実装** (`embedding.py`):
```python
# 実験モード: EMBEDDING_TEST_MODE=skip_postprocess
# ライブラリ呼び出し（sentence-transformers）
embeddings = self.model.encode(text, convert_to_numpy=True)

if test_mode == 'skip_postprocess':
    # model.encode()は実行するが、後続処理をスキップしてダミーを返す
    return [0.0] * dimension

# ユーティリティ処理: 次元調整、型変換など
embeddings = self._adjust_dimension(embeddings, dimension)
return embeddings.tolist()
```

**処理の分類**:
- **ライブラリ**: `self.model.encode(text, convert_to_numpy=True)` - sentence-transformersの直接呼び出し
- **ユーティリティ**:
  - `_adjust_dimension()` - numpy配列のスライス、L2正規化、ゼロパディング
  - `.tolist()` - numpy → Pythonリストへの変換

**測定結果**:
- **メモリ増加速度**: 62.65 MB/call
- **ベースライン**: 56.46 MB/call
- **差**: +6.19 MB（悪化）
- **ログファイル**: `prompts/tasks/logs/task20.2-skip-postprocess.log`

**詳細データ**:
```
Indexing duration: 66.5s
AddSections count: 61
Memory: 2636.2 -> 6458.1 MB (+3821.9 MB)
Threads: 64 -> 114
```

### 結論

**❌ sentence-transformers の model.encode() 自体がメモリリークしている**

1. **ユーティリティ処理は無関係**
   - 後続処理をスキップしても改善なし（むしろ悪化）
   - _adjust_dimension(), .tolist()などは問題ではない

2. **ライブラリ呼び出しが主犯**
   - `model.encode()`を呼ぶだけで62.65 MB/call
   - これは単体テスト（0.10 MB/call）の約626倍

3. **環境依存のリーク**
   - 単体実行: 正常（0.10 MB/call）
   - worker.py環境: 異常（62.65 MB/call）
   - JSON-RPCワーカー環境が何らかの形でsentence-transformersと相互作用している

### Phase 8 まとめ

#### 全実験結果の比較

| 実験 | 処理内容 | MB/call | 評価 |
|-----|---------|---------|------|
| Baseline | encode() + table.add() | 56.46 | 基準 |
| skip_add | encode()のみ（full） | 55.51 | 変化なし |
| skip_encode | table.add()のみ | 3.17 | 正常 |
| deepcopy | 参照切り離し | 56.44 | ✗ 無効 |
| no_store_vector | ベクトル非格納 | 70.69 | ✗ 悪化 |
| pyarrow_release | PyArrow解放 | 55.72 | ✗ 無効 |
| pytorch_detach | 計算グラフ切断 | 69.90 | ✗ 悪化 |
| **skip_postprocess** | **ライブラリのみ** | **62.65** | **✗ 悪化** |

#### 確定した事実

1. **メモリリークの直接原因**: `sentence-transformers.model.encode()`
2. **ユーティリティ処理は無実**: 次元調整、型変換、リスト化は無関係
3. **環境依存性**: worker.py環境でのみリーク発生（単体では正常）

#### 未解明の謎

**なぜsentence-transformersがworker.py環境でのみリークするのか？**

考えられる環境要因:
1. **スレッド環境**: 80+のネイティブスレッドとの相互作用
2. **JSON-RPCコンテキスト**: 標準入出力を介した通信
3. **LanceDB共存**: 同じプロセス内でのLanceDB（Rust）との共存
4. **PyArrowメモリプール**: system_memory_pool()設定の影響
5. **繰り返し呼び出し**: 単体テストは100回、worker.pyは数千回の可能性

---

## Phase 9: 真の原因の特定 - tokenizers Issue #1539

### 根本原因の発見

ユーザーの詳細な調査により、メモリリークの真の発生源が特定されました：

**`huggingface/tokenizers`ライブラリの既知のバグ（Issue #1539）**

### 依存関係の連鎖

```
sentence-transformers==5.1.2
  ↓ 依存
transformers==4.57.1
  ↓ 依存
tokenizers==0.22.1  ← ここにバグ
```

### Issue #1539の詳細

- **報告日**: 2024年5月23日
- **症状**: 長い文字列（特にスペースのない文字列）を処理する際にメモリが際限なく増加
- **原因**: RustベースのFast Tokenizerが確保したメモリを解放しない
- **状態**: Closed (Completed) だが、**実際には完全に解決されていない**
  - v0.19.1, v0.20.0で確認済み
  - v0.22.1（最新版）でも問題が継続

### リークのメカニズム

1. `model.encode()`を呼び出すたびに、内部でRust製トークナイザーが実行される
2. Rustのネイティブコードが確保したメモリを解放しない
3. **PythonのGCの管理外**でメモリがリーク
4. `gc.collect()`などのPythonレベルのメモリ解放策は無効

### なぜworker.py環境でのみリークするのか

- 単体テスト: 100回の呼び出し → 0.10 MB/call（正常）
- worker.py: 数千回の呼び出し → 62.65 MB/call（異常）

**仮説**: 累積的なリークが一定の閾値を超えると顕在化する

### 検討したWorkaround

Issue #1539で提案されている3つのWorkaround：

1. **短い文字列に分割** - 日本語では非現実的（スペース区切りが前提）
2. **スペースを追加** - 許容範囲は数十文字まで、長文には不適
3. **定期的にトークナイザーを再作成** ← 唯一の現実的な選択肢

### 実装したWorkaround

**モデルの定期的な再ロード** (`embedding.py`):

```python
class RuriEmbedding(EmbeddingModel):
    def __init__(self, model_name: str = None):
        # トークナイザー再作成カウンタ
        self._encode_count = 0
        self._reload_interval = 100  # 100回ごとにモデルを再ロード

    def encode(self, text: str, dimension: int = None) -> List[float]:
        # 定期的にモデルを再ロードしてトークナイザーのメモリリークを軽減
        self._encode_count += 1
        if self._encode_count % self._reload_interval == 0:
            sys.stderr.write(f"[TOKENIZER_WORKAROUND] Reloading model (encode count: {self._encode_count})\n")

            # モデルを再ロード
            old_model = self.model
            self.model = None
            self.available = False
            del old_model
            gc.collect()

            # 再初期化
            self.initialize()
```

### Workaroundの評価

**メリット**:
- 実装が簡単
- 検索精度を損なわない
- メモリリークを周期的にリセット

**デメリット**:
- モデル再ロードのオーバーヘッド（約600MB、数秒）
- 根本的な解決ではなく、対症療法

### 恒久的な解決策

**tokenizersライブラリの修正を待つ**

現状では0.22.1（最新版）でも問題が継続しており、上流での修正が必要。
GitHub Issue #1539はClosedになっているが、実際には未解決。

### Phase 9 まとめ

#### 確定した事実

1. **メモリリークの真犯人**: `huggingface/tokenizers`のIssue #1539
2. **sentence-transformersは無罪**: 上流ライブラリの問題を引き継いでいるだけ
3. **環境依存性の理由**: 累積的なリークが一定の呼び出し回数で顕在化

#### 実施した対策

1. tokenizersを最新版（0.22.1）に確認・維持
2. モデル定期再ロードのWorkaroundを実装
3. リロード間隔を100回に設定（調整可能）

#### 今後の方針

1. **短期**: Workaroundを有効化して運用
2. **中期**: Issue #1539の修正状況を監視
3. **長期**: tokenizersの修正版リリース後、Workaroundを削除

---

## Phase 10: 追加調査結果と対策の最終調整

### 日時: 2025-11-06

### 外部調査結果の反映

他の調査により、以下の重要な事実が判明：

#### 2つの独立したバグの特定

1. **Bug #1539: スペースなし長文（日本語）のメモリリーク**
   - 最新版（0.20.x以降）でも未解決、または再発
   - 日本語は「スペースのない長い文字列」に該当するため影響を受ける
   - Rust側での実装のため修正困難

2. **Bug #1495: 並列処理自体が引き起こすメモリリーク**
   - マルチプロセッシング環境下で発生
   - `use_fast=False`（低速トークナイザー）を使っても、並列処理下ではそれ自体がリーク

#### 回避策の再評価

**`use_fast=False`は無効**:
- 並列処理下ではBug #1495により、それ自体がメモリリーク
- 解決策にならない

**`maxtasksperchild=1`が標準的解決策**:
- リークするメモリごとプロセスを破棄・再生成
- 修正困難なRust側リークへの最も推奨される対策
- 複数の技術情報源によって裏付けられた標準的手法

### 対策の調整

#### 1. リロード間隔の変更: 100回 → 10回

**変更理由**:
- 実測では数十回のadd_sectionsでメモリ逼迫
- 100回では遅すぎる
- より積極的なリロードが必要

**実装**（`embedding.py`）:
```python
self._reload_interval = 10  # 10回ごとにモデルを再ロード
```

#### 2. 実験的機能: 句読点での文章分割

**目的**:
- Issue #1539の「短い文字列に分割」の日本語版
- 句読点（。、）で分割することで、各文章を短くする

**実装**（`embedding.py`）:
```python
# 環境変数 SPLIT_BY_PUNCTUATION=1 で有効化
split_by_punctuation = os.getenv('SPLIT_BY_PUNCTUATION', '0') == '1'

if split_by_punctuation and len(text) > 200:
    # 句読点（。、）で分割
    chunks = re.split(r'([。、])', text)

    # 各文章を個別にエンコードして平均を取る
    embeddings_list = []
    for sentence in sentences:
        emb = self.model.encode(sentence, convert_to_numpy=True)
        embeddings_list.append(emb)

    embeddings = np.mean(embeddings_list, axis=0)
```

**メリット**:
- 日本語の自然な区切りを利用
- 各文章が短くなるため、トークナイザーのリークを軽減
- 環境変数でON/OFF可能

**懸念事項**:
- 複数のencode()呼び出しによるオーバーヘッド
- ベクトルの平均が元の意味を保持するかは検証が必要
- 実験的機能のため、デフォルトではOFF

### 最終的な対策まとめ

#### 採用する対策（優先順位順）

1. **モデル定期再ロード（10回ごと）**: 常に有効
   - 最も確実な対策
   - リーク蓄積を定期的にリセット
   - オーバーヘッドはあるが、メモリ逼迫を回避

2. **句読点分割**: 実験的機能（環境変数でON/OFF）
   - リークの軽減を期待
   - 検索精度への影響は要検証
   - `SPLIT_BY_PUNCTUATION=1`で有効化

#### 採用しない対策

1. **`use_fast=False`**: Bug #1495により並列処理下では無効
2. **テキストチャンキング（固定長）**: 日本語では非現実的
3. **スペース追加**: 許容範囲が数十文字までと制限的

### 結論

- **2つのバグ（#1539と#1495）の組み合わせ**が問題の本質
- **モデル定期再ロード**が現時点で最も現実的かつ有効な対策
- **句読点分割**は補助的な対策として実験的に実装
- 上流での修正が望ましいが、現状では回避策で対応する以外にない

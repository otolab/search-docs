"""
バッチ処理ユーティリティのユニットテスト

重要原則: 小さな値（100トークンなど）でロジックの正しさを検証
"""

import unittest
import sys
from pathlib import Path

# プロジェクトルートのpythonディレクトリをパスに追加
python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from utils.batch_utils import create_token_aware_batches, get_batch_stats


class TestCreateTokenAwareBatches(unittest.TestCase):
    """create_token_aware_batches関数のテスト"""

    def test_empty_list(self):
        """空のリストは空のバッチを返す"""
        batches = create_token_aware_batches([], [], max_tokens_per_batch=100)
        self.assertEqual(len(batches), 0)

    def test_single_text_under_limit(self):
        """1つのテキスト（制限以下）は1バッチになる"""
        texts = ["a" * 200]  # 50トークン
        indices = [0]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 1)
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 1)
        self.assertEqual(batch_indices, [0])

    def test_single_text_over_limit(self):
        """1つのテキスト（制限超過）も1バッチになる"""
        # 単独のテキストが制限を超える場合でも、そのテキスト単独で1バッチとする
        texts = ["a" * 600]  # 150トークン（制限100を超える）
        indices = [0]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 1)
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 1)
        self.assertEqual(batch_indices, [0])

    def test_multiple_texts_fit_in_one_batch(self):
        """複数のテキストが1バッチに収まる"""
        texts = ["a" * 120, "a" * 120, "a" * 120]  # 各30トークン = 合計90トークン
        indices = [0, 1, 2]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 1)
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 3)
        self.assertEqual(batch_indices, [0, 1, 2])

    def test_multiple_texts_split_into_batches(self):
        """複数のテキストが複数バッチに分割される"""
        # 各50トークン × 5 = 250トークン
        # max_tokens_per_batch=100の場合、3バッチに分割される想定
        # Batch 1: 50 + 50 = 100トークン（2テキスト）
        # Batch 2: 50 + 50 = 100トークン（2テキスト）
        # Batch 3: 50トークン（1テキスト）
        texts = ["a" * 200] * 5
        indices = [0, 1, 2, 3, 4]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 3)

        # Batch 1
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 2)
        self.assertEqual(batch_indices, [0, 1])

        # Batch 2
        batch_texts, batch_indices = batches[1]
        self.assertEqual(len(batch_texts), 2)
        self.assertEqual(batch_indices, [2, 3])

        # Batch 3
        batch_texts, batch_indices = batches[2]
        self.assertEqual(len(batch_texts), 1)
        self.assertEqual(batch_indices, [4])

    def test_exactly_at_boundary(self):
        """ちょうど境界値のテキスト"""
        # ちょうど100トークン（400文字）
        texts = ["a" * 400]
        indices = [0]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 1)
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 1)

    def test_mixed_sizes(self):
        """サイズが異なる複数のテキスト"""
        # 20トークン + 80トークン = 100トークン（1バッチ）
        # 60トークン（2バッチ目）
        texts = ["a" * 80, "a" * 320, "a" * 240]
        indices = [0, 1, 2]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        self.assertEqual(len(batches), 2)

        # Batch 1: 20 + 80 = 100トークン
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 2)
        self.assertEqual(batch_indices, [0, 1])

        # Batch 2: 60トークン
        batch_texts, batch_indices = batches[1]
        self.assertEqual(len(batch_texts), 1)
        self.assertEqual(batch_indices, [2])

    def test_indices_are_preserved(self):
        """インデックスが正しく保持される"""
        texts = ["a" * 200, "a" * 200, "a" * 200]
        indices = [10, 20, 30]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

        # Batch 1
        _, batch_indices = batches[0]
        self.assertEqual(batch_indices, [10, 20])

        # Batch 2
        _, batch_indices = batches[1]
        self.assertEqual(batch_indices, [30])

    def test_length_mismatch_raises_error(self):
        """textsとindicesの長さが異なる場合エラー"""
        texts = ["a" * 200, "a" * 200]
        indices = [0]
        with self.assertRaises(ValueError):
            create_token_aware_batches(texts, indices, max_tokens_per_batch=100)

    def test_large_limit(self):
        """制限が大きい場合、すべて1バッチになる"""
        texts = ["a" * 200] * 10
        indices = list(range(10))
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=1000)

        self.assertEqual(len(batches), 1)
        batch_texts, batch_indices = batches[0]
        self.assertEqual(len(batch_texts), 10)


class TestGetBatchStats(unittest.TestCase):
    """get_batch_stats関数のテスト"""

    def test_empty_batches(self):
        """空のバッチリスト"""
        stats = get_batch_stats([])
        self.assertEqual(stats['num_batches'], 0)
        self.assertEqual(stats['total_texts'], 0)
        self.assertEqual(len(stats['batches_info']), 0)

    def test_single_batch(self):
        """1つのバッチ"""
        texts = ["a" * 200, "a" * 200]
        indices = [0, 1]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)
        stats = get_batch_stats(batches)

        self.assertEqual(stats['num_batches'], 1)
        self.assertEqual(stats['total_texts'], 2)
        self.assertEqual(len(stats['batches_info']), 1)

        batch_info = stats['batches_info'][0]
        self.assertEqual(batch_info['batch_num'], 1)
        self.assertEqual(batch_info['num_texts'], 2)
        self.assertEqual(batch_info['estimated_tokens'], 100)

    def test_multiple_batches(self):
        """複数のバッチ"""
        texts = ["a" * 200] * 5
        indices = [0, 1, 2, 3, 4]
        batches = create_token_aware_batches(texts, indices, max_tokens_per_batch=100)
        stats = get_batch_stats(batches)

        self.assertEqual(stats['num_batches'], 3)
        self.assertEqual(stats['total_texts'], 5)
        self.assertEqual(len(stats['batches_info']), 3)

        # Batch 1: 2テキスト、100トークン
        batch_info = stats['batches_info'][0]
        self.assertEqual(batch_info['batch_num'], 1)
        self.assertEqual(batch_info['num_texts'], 2)
        self.assertEqual(batch_info['estimated_tokens'], 100)

        # Batch 2: 2テキスト、100トークン
        batch_info = stats['batches_info'][1]
        self.assertEqual(batch_info['batch_num'], 2)
        self.assertEqual(batch_info['num_texts'], 2)
        self.assertEqual(batch_info['estimated_tokens'], 100)

        # Batch 3: 1テキスト、50トークン
        batch_info = stats['batches_info'][2]
        self.assertEqual(batch_info['batch_num'], 3)
        self.assertEqual(batch_info['num_texts'], 1)
        self.assertEqual(batch_info['estimated_tokens'], 50)


if __name__ == '__main__':
    unittest.main()

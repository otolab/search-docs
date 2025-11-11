"""
トークン推定ユーティリティのユニットテスト
"""

import unittest
import sys
from pathlib import Path

# プロジェクトルートのpythonディレクトリをパスに追加
python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from utils.token_utils import estimate_tokens, estimate_total_tokens


class TestEstimateTokens(unittest.TestCase):
    """estimate_tokens関数のテスト"""

    def test_empty_string(self):
        """空文字列は0トークン"""
        self.assertEqual(estimate_tokens(""), 0)

    def test_small_text(self):
        """小さなテキスト"""
        # 5文字 -> 5 // 4 = 1トークン
        self.assertEqual(estimate_tokens("Hello"), 1)

    def test_exactly_100_tokens(self):
        """ちょうど100トークン（400文字）"""
        text = "a" * 400
        self.assertEqual(estimate_tokens(text), 100)

    def test_slightly_over_100_tokens(self):
        """100トークンを少し超える（404文字 -> 101トークン）"""
        text = "a" * 404
        self.assertEqual(estimate_tokens(text), 101)

    def test_slightly_under_100_tokens(self):
        """100トークン未満（396文字 -> 99トークン）"""
        text = "a" * 396
        self.assertEqual(estimate_tokens(text), 99)

    def test_large_text(self):
        """大きなテキスト（8000トークン = 32000文字）"""
        text = "a" * 32000
        self.assertEqual(estimate_tokens(text), 8000)

    def test_7500_tokens(self):
        """7500トークン（30000文字）- スキップ境界値"""
        text = "a" * 30000
        self.assertEqual(estimate_tokens(text), 7500)

    def test_multibyte_characters(self):
        """マルチバイト文字（日本語）"""
        # 4文字（あいうえ） -> 1トークン
        text = "あいうえ"
        self.assertEqual(estimate_tokens(text), 1)

        # 400文字 -> 100トークン
        text = "あ" * 400
        self.assertEqual(estimate_tokens(text), 100)


class TestEstimateTotalTokens(unittest.TestCase):
    """estimate_total_tokens関数のテスト"""

    def test_empty_list(self):
        """空のリストは0トークン"""
        self.assertEqual(estimate_total_tokens([]), 0)

    def test_single_text(self):
        """単一のテキスト"""
        texts = ["Hello"]  # 1トークン
        self.assertEqual(estimate_total_tokens(texts), 1)

    def test_multiple_texts(self):
        """複数のテキスト"""
        # 各5文字 = 各1トークン、合計2トークン
        texts = ["Hello", "World"]
        self.assertEqual(estimate_total_tokens(texts), 2)

    def test_mixed_sizes(self):
        """サイズが異なる複数のテキスト"""
        texts = [
            "a" * 200,   # 50トークン
            "a" * 400,   # 100トークン
            "a" * 200,   # 50トークン
        ]
        # 合計: 50 + 100 + 50 = 200トークン
        self.assertEqual(estimate_total_tokens(texts), 200)

    def test_batch_size_scenario(self):
        """バッチサイズ計算のシナリオ"""
        # 5つのテキスト、各50トークン = 合計250トークン
        # max_tokens_per_batch=100の場合、3バッチに分割される想定
        texts = ["a" * 200] * 5  # 各200文字 = 50トークン
        self.assertEqual(estimate_total_tokens(texts), 250)


if __name__ == '__main__':
    unittest.main()

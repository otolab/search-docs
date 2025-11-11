"""
セクションフィルタリングユーティリティのユニットテスト

重要原則: 小さな値（100トークンなど）でロジックの正しさを検証
"""

import unittest
import sys
from pathlib import Path

# プロジェクトルートのpythonディレクトリをパスに追加
python_dir = Path(__file__).parent.parent
sys.path.insert(0, str(python_dir))

from utils.section_filter import filter_sections_by_token_limit, get_texts_to_encode


class TestFilterSectionsByTokenLimit(unittest.TestCase):
    """filter_sections_by_token_limit関数のテスト"""

    def test_empty_list(self):
        """空のリストは空のリストを返す"""
        valid, skipped = filter_sections_by_token_limit([], max_tokens=100)
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(skipped), 0)

    def test_all_under_limit(self):
        """すべてのセクションが制限以下の場合"""
        sections = [
            {'heading': 'A', 'content': 'a' * 100, 'vector': None},  # 26トークン
            {'heading': 'B', 'content': 'a' * 200, 'vector': None},  # 51トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 2)
        self.assertEqual(len(skipped), 0)

    def test_all_over_limit(self):
        """すべてのセクションが制限を超える場合"""
        sections = [
            {'heading': 'A', 'content': 'a' * 500, 'vector': None},  # 125トークン
            {'heading': 'B', 'content': 'a' * 600, 'vector': None},  # 150トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 0)
        self.assertEqual(len(skipped), 2)
        self.assertEqual(skipped[0]['heading'], 'A')
        self.assertEqual(skipped[1]['heading'], 'B')

    def test_mixed_sections(self):
        """制限以下と制限超過が混在する場合"""
        sections = [
            {'heading': 'Small', 'content': 'a' * 100, 'vector': None},   # 26トークン
            {'heading': 'Large', 'content': 'a' * 500, 'vector': None},   # 125トークン
            {'heading': 'Medium', 'content': 'a' * 200, 'vector': None},  # 51トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 2)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(valid[0]['heading'], 'Small')
        self.assertEqual(valid[1]['heading'], 'Medium')
        self.assertEqual(skipped[0]['heading'], 'Large')

    def test_exactly_at_limit(self):
        """ちょうど制限値のセクション"""
        # ちょうど100トークン = 400文字 - heading分 = 394文字
        sections = [
            {'heading': 'Test', 'content': 'a' * 394, 'vector': None},  # ちょうど100トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 1)
        self.assertEqual(len(skipped), 0)

    def test_one_char_over_limit(self):
        """1文字だけ制限を超える場合"""
        # 101トークン = 404文字 - heading分 = 399文字
        sections = [
            {'heading': 'Test', 'content': 'a' * 399, 'vector': None},  # 101トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 0)
        self.assertEqual(len(skipped), 1)

    def test_already_vectorized_sections(self):
        """既にベクトル化されたセクションはチェックしない"""
        sections = [
            {'heading': 'A', 'content': 'a' * 1000, 'vector': [0.1, 0.2, 0.3]},  # 大きいが既にベクトル化済み
            {'heading': 'B', 'content': 'a' * 100, 'vector': None},
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 2)  # 両方とも有効
        self.assertEqual(len(skipped), 0)

    def test_skipped_info_includes_token_count(self):
        """スキップされたセクションの情報にトークン数が含まれる"""
        sections = [
            {'heading': 'Large', 'content': 'a' * 500, 'vector': None},
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]['heading'], 'Large')
        self.assertIn('estimated_tokens', skipped[0])
        # "Large\n" + 500文字 = 506文字 = 126トークン
        self.assertEqual(skipped[0]['estimated_tokens'], 126)

    def test_multibyte_characters(self):
        """マルチバイト文字（日本語）を含むセクション"""
        sections = [
            {'heading': '見出し', 'content': 'あ' * 100, 'vector': None},  # 27トークン
            {'heading': '大きな見出し', 'content': 'あ' * 500, 'vector': None},  # 127トークン
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)

        self.assertEqual(len(valid), 1)
        self.assertEqual(len(skipped), 1)

    def test_document_root_over_7500_tokens(self):
        """(document root)セクションが7500トークンを超える場合はスキップされる"""
        # 12384トークン = 49536文字（content） + 15文字（heading）= 49551文字 = 12387トークン
        sections = [
            {'heading': '(document root)', 'content': 'a' * 49536, 'vector': None},
        ]
        valid, skipped = filter_sections_by_token_limit(sections, max_tokens=7500)

        self.assertEqual(len(valid), 0)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]['heading'], '(document root)')
        self.assertGreater(skipped[0]['estimated_tokens'], 7500)


class TestGetTextsToEncode(unittest.TestCase):
    """get_texts_to_encode関数のテスト"""

    def test_empty_list(self):
        """空のリストは空のリストを返す"""
        texts, indices = get_texts_to_encode([])
        self.assertEqual(len(texts), 0)
        self.assertEqual(len(indices), 0)

    def test_all_need_encoding(self):
        """すべてのセクションがベクトル化が必要な場合"""
        sections = [
            {'heading': 'A', 'content': 'text1', 'vector': None},
            {'heading': 'B', 'content': 'text2', 'vector': None},
        ]
        texts, indices = get_texts_to_encode(sections)

        self.assertEqual(len(texts), 2)
        self.assertEqual(indices, [0, 1])
        self.assertEqual(texts[0], 'A\ntext1')
        self.assertEqual(texts[1], 'B\ntext2')

    def test_all_already_vectorized(self):
        """すべてのセクションが既にベクトル化済みの場合"""
        sections = [
            {'heading': 'A', 'content': 'text1', 'vector': [0.1, 0.2]},
            {'heading': 'B', 'content': 'text2', 'vector': [0.3, 0.4]},
        ]
        texts, indices = get_texts_to_encode(sections)

        self.assertEqual(len(texts), 0)
        self.assertEqual(len(indices), 0)

    def test_mixed_sections(self):
        """ベクトル化が必要なものと不要なものが混在"""
        sections = [
            {'heading': 'A', 'content': 'text1', 'vector': None},
            {'heading': 'B', 'content': 'text2', 'vector': [0.1, 0.2]},
            {'heading': 'C', 'content': 'text3', 'vector': None},
        ]
        texts, indices = get_texts_to_encode(sections)

        self.assertEqual(len(texts), 2)
        self.assertEqual(indices, [0, 2])  # インデックスが保持される
        self.assertEqual(texts[0], 'A\ntext1')
        self.assertEqual(texts[1], 'C\ntext3')

    def test_indices_are_correct(self):
        """インデックスが正しく抽出される"""
        sections = [
            {'heading': 'A', 'content': 'a', 'vector': [0.1]},  # スキップ
            {'heading': 'B', 'content': 'b', 'vector': None},   # インデックス1
            {'heading': 'C', 'content': 'c', 'vector': [0.2]},  # スキップ
            {'heading': 'D', 'content': 'd', 'vector': None},   # インデックス3
            {'heading': 'E', 'content': 'e', 'vector': None},   # インデックス4
        ]
        texts, indices = get_texts_to_encode(sections)

        self.assertEqual(indices, [1, 3, 4])
        self.assertEqual(len(texts), 3)


if __name__ == '__main__':
    unittest.main()

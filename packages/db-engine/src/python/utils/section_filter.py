"""
セクションフィルタリングユーティリティ

トークン数制限を超えるセクションをスキップする機能を提供。
"""

from typing import List, Dict, Any, Tuple
from .token_utils import estimate_tokens


def filter_sections_by_token_limit(
    sections: List[Dict[str, Any]],
    max_tokens: int = 7500
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    トークン数制限を超えるセクションをフィルタリング

    ベクトル化が必要なセクションのうち、トークン数が制限を超えるものを
    スキップする。各セクションは heading と content フィールドを持つ必要がある。

    Args:
        sections: セクションのリスト（各セクションはheading, contentを含む辞書）
        max_tokens: 1セクションあたりの最大トークン数

    Returns:
        (valid_sections, skipped_sections)のタプル
        - valid_sections: トークン数が制限以下のセクションのリスト
        - skipped_sections: スキップされたセクションの情報のリスト
          各要素は {'heading': str, 'estimated_tokens': int} の辞書

    Examples:
        >>> sections = [
        ...     {'heading': 'Small', 'content': 'a' * 100, 'vector': None},
        ...     {'heading': 'Large', 'content': 'a' * 500, 'vector': None},
        ...     {'heading': 'Medium', 'content': 'a' * 200, 'vector': None},
        ... ]
        >>> valid, skipped = filter_sections_by_token_limit(sections, max_tokens=100)
        >>> len(valid)
        2
        >>> len(skipped)
        1
        >>> skipped[0]['heading']
        'Large'

    Notes:
        - vectorフィールドが存在し、値がある場合は既にベクトル化済みと判断し、チェックしない
        - heading と content を結合したテキストでトークン数を推定
    """
    valid_sections = []
    skipped_sections = []

    for section in sections:
        # 既にベクトル化済みの場合はスキップしない
        if "vector" in section and section["vector"]:
            valid_sections.append(section)
            continue

        # テキストを結合してトークン数を推定
        text = f"{section['heading']}\n{section['content']}"
        estimated_tokens = estimate_tokens(text)

        # トークン数が制限以下の場合は有効
        if estimated_tokens <= max_tokens:
            valid_sections.append(section)
        else:
            # スキップされたセクションの情報を記録
            skipped_sections.append({
                'heading': section['heading'],
                'estimated_tokens': estimated_tokens
            })

    return valid_sections, skipped_sections


def get_texts_to_encode(
    sections: List[Dict[str, Any]]
) -> Tuple[List[str], List[int]]:
    """
    ベクトル化が必要なセクションからテキストとインデックスを抽出

    Args:
        sections: セクションのリスト

    Returns:
        (texts, indices)のタプル
        - texts: ベクトル化するテキストのリスト
        - indices: 各テキストに対応するセクションのインデックス

    Examples:
        >>> sections = [
        ...     {'heading': 'A', 'content': 'text1', 'vector': None},
        ...     {'heading': 'B', 'content': 'text2', 'vector': [0.1, 0.2]},
        ...     {'heading': 'C', 'content': 'text3', 'vector': None},
        ... ]
        >>> texts, indices = get_texts_to_encode(sections)
        >>> len(texts)
        2
        >>> indices
        [0, 2]
        >>> texts[0]
        'A\\ntext1'
    """
    texts = []
    indices = []

    for i, section in enumerate(sections):
        # ベクトル化が必要な場合のみ
        if "vector" not in section or not section["vector"]:
            text = f"{section['heading']}\n{section['content']}"
            texts.append(text)
            indices.append(i)

    return texts, indices

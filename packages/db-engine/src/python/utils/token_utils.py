"""
トークン数推定ユーティリティ

Ruri Embeddingモデル（cl-nagoya/ruri-v3-30m）のトークン数を
文字数ベースで保守的に推定する。
"""

from typing import List


def estimate_tokens(text: str) -> int:
    """
    テキストのトークン数を推定する

    推定方法: 文字数 / 4（保守的な推定）

    Args:
        text: 推定対象のテキスト

    Returns:
        推定トークン数

    Examples:
        >>> estimate_tokens("Hello")
        1
        >>> estimate_tokens("a" * 400)
        100
        >>> estimate_tokens("")
        0
    """
    return len(text) // 4


def estimate_total_tokens(texts: List[str]) -> int:
    """
    複数のテキストの合計トークン数を推定する

    Args:
        texts: 推定対象のテキストのリスト

    Returns:
        合計推定トークン数

    Examples:
        >>> estimate_total_tokens(["Hello", "World"])
        2
        >>> estimate_total_tokens([])
        0
    """
    return sum(estimate_tokens(text) for text in texts)

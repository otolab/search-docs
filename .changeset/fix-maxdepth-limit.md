---
'@search-docs/types': patch
---

maxDepthの上限を3から6に変更

Markdownの見出しはH6（######）まで存在するため、config.indexing.maxDepthの範囲を0-6に拡張しました。これにより、H4/H5/H6見出しを独立したセクションとして作成できるようになります。

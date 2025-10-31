---
"@search-docs/mcp-server": patch
---

package.jsonからバージョンを動的に読み込むように修正

ハードコードされていた'0.1.0'をpackage.jsonから読み込むように変更し、-Vオプションで正しいバージョンが表示されるようにしました。

---
"@search-docs/cli": patch
"@search-docs/config": minor
"@search-docs/types": minor
"@search-docs/server": patch
"@search-docs/storage": patch
"@search-docs/mcp-server": patch
---

Respect .gitignore during file watching and add the clearer respectGitignore setting while preserving compatibility with ignoreGitignore. Serialize indexing and deletion, reconcile missing documents at startup, and improve shutdown and recovery of indexing services.

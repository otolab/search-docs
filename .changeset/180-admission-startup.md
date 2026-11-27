---
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/mcp-server": patch
"@search-docs/cli": patch
---

Remove admission lock serialization from normal startup so concurrent MCP/server launches no longer time out or leave a stale `admission` lock that blocks every later startup (#180).

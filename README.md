# brave-mcp-server

Brave Search API 的 [MCP](https://modelcontextprotocol.io) 服务器。把 Brave 的
Web Search 端点（`GET /res/v1/web/search`）暴露成单个 `web_search` 工具，供
Claude Code 等 MCP 客户端调用。

服务器用 stdio 传输，stdout 只写 JSON-RPC，日志走 stderr。由 `npx` 按需拉起，
不需要预先安装。

## 使用

### 配置

在 MCP 客户端的配置文件里加一条即可。Claude Code 写在 `~/.claude.json` 顶层的
`mcpServers` 里：

```json
{
  "mcpServers": {
    "brave-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "brave-mcp-server"],
      "env": {
        "BRAVE_API_KEY": "你的订阅令牌"
      }
    }
  }
}
```

改完重启客户端生效。

Claude Code 也可以用命令写入同样一段配置：

```bash
claude mcp add brave-search --scope user \
  -e BRAVE_API_KEY=你的订阅令牌 \
  -- npx -y brave-mcp-server
```

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `BRAVE_API_KEY` | 是 | Brave Search 订阅令牌，也可用 `BRAVE_SEARCH_API_KEY` |
| `BRAVE_BASE_URL` | 否 | 上游地址，默认 `https://api.search.brave.com` |

缺少 API key 时服务器会打印一行说明并以退出码 1 结束，而不是带着空 key 去请求。

### 工具：`web_search`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `q` | string（必填） | 查询词，支持 `site:`、`ext:`、`intitle:`、`"精确短语"`、`-排除词` |
| `count` | integer | 返回条数，默认 10，范围 1–20 |
| `offset` | integer | 翻页偏移，默认 0，范围 0–9（需配合相同的 `count`） |
| `freshness` | string | `pd` / `pw` / `pm` / `py`，或 `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | string | 2 位国家码（`US`、`CN`、`DE`）或 `ALL`，默认 `US` |
| `search_lang` | string | 语言码。中文只接受 `zh-hans` / `zh-hant`，服务器会把 `zh`、`zh-cn`、`cn` 等写法归一化 |
| `safesearch` | string | `off` / `moderate` / `strict` |
| `result_filter` | string[] | 只取某类结果：`web`、`news`、`discussions`、`faq`、`infobox`、`videos`、`locations`、`query` |
| `goggles` | string | 自定义排序规则，可传 GitHub 托管的 goggle 地址或内联规则 |
| `extra_snippets` | boolean | 每条结果额外返回最多 5 段摘录 |
| `text_decorations` | boolean | 摘要是否保留 `<strong>` 高亮标记，默认 `false` |

响应会按 `网页结果 / 新闻 / 论坛讨论 / 常见问题 / 视频 / 地点 / 知识卡片`
分块渲染成纯文本：HTML 标签和实体被清洗掉，每条结果固定为
「标题 / 链接 / 时效·来源 / 摘要」的缩进格式。

未暴露的上游参数：`ui_lang`、`units`、`spellcheck`、`operators`、
`enable_rich_callback`、`include_fetch_metadata`——对检索结果影响很小，
或需要二次回调，为了让工具签名保持精简而略去。

## 开发

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `bin/brave-mcp-server.js` | 可执行入口，只负责启动 |
| `src/server.js` | JSON-RPC 分发与 stdio 生命周期 |
| `src/tools.js` | 工具声明、参数校验与执行 |
| `src/brave.js` | Brave API 客户端与错误整理 |
| `src/format.js` | 响应渲染成纯文本 |

### 本地运行

```bash
BRAVE_API_KEY=你的令牌 npm start
```

手动跑一轮协议交互（stdin 每行一条 JSON-RPC 消息）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_search","arguments":{"q":"hello"}}}' \
| BRAVE_API_KEY=你的令牌 node bin/brave-mcp-server.js
```

### 让客户端跑本地源码

把配置里的 `args` 指向仓库目录即可：

```json
"args": ["-y", "D:/workspace/brave-mcp-server"]
```

注意别在仓库目录里执行这条 npx——npx 会优先解析当前目录的同名包，报
`brave-mcp-server 不是内部或外部命令`。从别的目录调用，或者直接用
`node bin/brave-mcp-server.js`。

## License

[MIT](LICENSE)

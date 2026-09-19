#!/usr/bin/env node
/**
 * brave-mcp-server 的可执行入口。
 *
 * 真正的实现放在 src/ 下，这里只负责启动 stdio 传输的服务器。
 * 抽成单独文件是为了让 `bin` 指向一个职责单一的脚本，也方便在
 * package.json 的 exports 之外单独引用。
 */

import { main } from '../src/server.js';

main();

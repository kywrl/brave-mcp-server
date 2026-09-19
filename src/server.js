/**
 * brave-mcp-server
 *
 * 把 Brave Search API 的 Web Search 端点（GET /res/v1/web/search）暴露成 MCP 工具。
 *
 * 环境变量：
 *   BRAVE_API_KEY / BRAVE_SEARCH_API_KEY  必填，Brave Search 的订阅令牌
 *   BRAVE_BASE_URL                        可选，默认 https://api.search.brave.com
 *   BRAVE_MCP_LOG_LEVEL                   可选，debug 时把每条请求也打到 stderr
 *
 * 未暴露的 API 参数：ui_lang、units、spellcheck、operators、
 * enable_rich_callback、include_fetch_metadata——对检索结果影响很小或需要
 * 二次回调，保持工具签名精简。
 */

import { createInterface } from 'node:readline';
import { readConfig } from './brave.js';
import { callTool, errorResult, TOOLS } from './tools.js';

export const SERVER_NAME = 'brave-search';
export const SERVER_VERSION = '1.0.0';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** stderr 用于日志，stdout 只留给 JSON-RPC */
function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/**
 * 处理单条 JSON-RPC 消息，返回响应对象；通知类消息返回 null。
 *
 * 抽成纯函数（不碰 stdout）是为了能脱离进程单独测试。
 *
 * @param {object} message 解析后的 JSON-RPC 消息
 * @param {{baseUrl: string, apiKey: string}} config
 */
export async function handleRequest(message, config) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : ok({});

    case 'tools/list':
      return ok({ tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        return ok(await callTool(name, args, config));
      } catch (error) {
        return ok(errorResult(`工具 ${name} 执行异常：${error.message}`));
      }
    }

    default:
      return isNotification ? null : fail(-32601, `不支持的方法：${method}`);
  }
}

/**
 * 启动 stdio 传输的服务器。
 *
 * @param {{config?: {baseUrl: string, apiKey: string}, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, onExit?: (code: number) => void}} [options]
 */
export function startServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const exit = options.onExit ?? ((code) => process.exit(code));

  const config = options.config ?? readConfig();

  if (!config.apiKey) {
    log('缺少环境变量 BRAVE_API_KEY（或 BRAVE_SEARCH_API_KEY），无法调用 Brave Search API。');
    exit(1);
    return;
  }

  // stdout 接管道时 write 是异步的。这里跟踪在途写入，只是为了知道
  // 「什么时候可以退」——真正的退出交给事件循环自然排空，见下面
  // shutdownIfDrained 的说明。
  let pendingWrites = 0;
  const send = (message) => {
    pendingWrites += 1;
    output.write(`${JSON.stringify(message)}\n`, () => {
      pendingWrites -= 1;
      shutdownIfDrained();
    });
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  // 在途请求计数：stdin 关闭时可能还有 tools/call 没跑完（检索要几秒），
  // 直接退出会把已经发出去的响应丢掉。
  const inFlight = new Set();
  let closing = false;
  let exiting = false;

  /**
   * 等请求和写入都落地后，把 stdin 解绑，让事件循环自然结束。
   *
   * 这里刻意不调用 process.exit()：在 stdin 已关闭、且本函数是由 stdout
   * 写回调驱动的情况下，强制退出会撞上 libuv 正在关闭 async handle 的时序，
   * Windows 上稳定复现
   *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
   * 并让退出码变成 127——调用方会误以为服务器崩了。解绑 stdin 之后没有
   * 待处理的 handle，进程会以 0 自行退出。
   */
  function shutdownIfDrained() {
    if (exiting || !closing) return;
    if (inFlight.size > 0 || pendingWrites > 0) return;
    exiting = true;
    input.unref?.();
    output.unref?.();
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      log(`忽略非法 JSON 行：${trimmed.slice(0, 200)}`);
      return;
    }

    // 不 await，允许并发处理；JSON-RPC 靠 id 匹配响应
    const task = Promise.resolve()
      .then(() => handleRequest(message, config))
      .then((response) => {
        if (response) send(response);
      })
      .catch((error) => {
        log(`处理 ${message?.method} 时异常：${error.stack || error.message}`);
        if (message?.id !== undefined && message?.id !== null) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `内部错误：${error.message}` } });
        }
      })
      .finally(() => {
        inFlight.delete(task);
        shutdownIfDrained();
      });
    inFlight.add(task);
  });

  rl.on('close', () => {
    closing = true;
    shutdownIfDrained();
  });

  log(`已启动 v${SERVER_VERSION}${process.env.BRAVE_MCP_LOG_LEVEL === 'debug' ? '（debug 日志已开启）' : ''}`);
}

/** bin 入口调用的启动函数 */
export function main() {
  startServer();
}

/**
 * Brave Search API 客户端。
 *
 * 只负责「发请求 + 把各种失败整理成人能看懂的一句话」，结果长什么样交给
 * format.js 决定。
 */

const DEFAULT_BASE_URL = 'https://api.search.brave.com';

/**
 * 读取运行时配置。之所以做成函数而不是模块级常量，是为了让 bin 在
 * 启动后（而不是 import 时）就能拿到最新的 process.env——也让单元测试
 * 有机会改掉环境变量。
 */
export function readConfig(env = process.env) {
  return {
    baseUrl: (env.BRAVE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY || '',
  };
}

export class BraveApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BraveApiError';
  }
}

function describeStatus(status) {
  switch (status) {
    case 401:
    case 403:
      return '请检查 BRAVE_API_KEY 是否有效、以及订阅是否覆盖 Web Search 端点。';
    case 422:
      return '参数校验失败，请检查取值是否在上游允许的范围内。';
    case 429:
      return '已触发频率限制（免费档约每秒 1 次、每月 2000 次），请稍后重试。';
    default:
      return '';
  }
}

/**
 * 调用 GET /res/v1/web/search。
 *
 * @param {URLSearchParams} query 已经拼好的查询参数
 * @param {{baseUrl: string, apiKey: string}} config
 * @param {number} timeoutMs
 * @returns {Promise<object>} 上游返回的 JSON
 */
export async function webSearch(query, config, timeoutMs) {
  const url = `${config.baseUrl}/res/v1/web/search?${query.toString()}`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'x-subscription-token': config.apiKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new BraveApiError(`请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已中止`);
    }
    throw new BraveApiError(error?.message || String(error));
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new BraveApiError(`HTTP ${response.status}，响应不是合法 JSON：${raw.slice(0, 300)}`);
  }

  if (!response.ok) {
    // Brave 的错误体形如
    // {"error":{"id":"...","status":422,"detail":"...","meta":{"errors":[{loc,msg,type}]}}}
    const detail = data?.error?.detail || data?.error?.code || `HTTP ${response.status}`;
    const fields = (data?.error?.meta?.errors ?? [])
      .map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : '';
        return [field, item?.msg].filter(Boolean).join(': ');
      })
      .filter(Boolean);
    const hint = describeStatus(response.status);
    throw new BraveApiError([detail, ...fields, hint].filter(Boolean).join(' '));
  }

  return data;
}

/**
 * MCP 工具的声明与执行。
 */

import { webSearch } from './brave.js';
import { renderResults } from './format.js';

/** 上游限制：count 取值 1-20，offset 取值 0-9（配合 count 翻页）。 */
export const DEFAULT_COUNT = 10;
export const MAX_COUNT = 20;
export const MIN_COUNT = 1;
export const MAX_OFFSET = 9;

export const SEARCH_TIMEOUT_MS = 30_000;

/** 各区块最多渲染几条，避免一次搜索结果把上下文撑爆 */
const RENDER_LIMITS = { web: MAX_COUNT, discussions: 5, faq: 5, verticals: 5 };

const RESULT_FILTERS = ['discussions', 'faq', 'infobox', 'news', 'query', 'videos', 'web', 'locations'];
const SAFESEARCH_VALUES = ['off', 'moderate', 'strict'];
const FRESHNESS_VALUES = ['pd', 'pw', 'pm', 'py'];

/**
 * search_lang 在上游是枚举，中文只接受 zh-hans / zh-hant——传 zh、zh-cn、cn
 * 都会 422。这里把常见写法归一到上游认识的值，免得模型按直觉传 zh 就失败。
 */
const LANG_ALIASES = {
  zh: 'zh-hans',
  'zh-cn': 'zh-hans',
  'zh-sg': 'zh-hans',
  'zh-my': 'zh-hans',
  cn: 'zh-hans',
  chinese: 'zh-hans',
  'zh-tw': 'zh-hant',
  'zh-hk': 'zh-hant',
  'zh-mo': 'zh-hant',
};

export const TOOLS = [
  {
    name: 'web_search',
    description: [
      '使用 Brave Search 检索互联网，返回标题、链接和摘要。',
      '适用于查询当前信息、新闻、文档或任何需要联网才能回答的问题。',
      '支持按时效（freshness）、地区（country）、语言（search_lang）过滤，',
      '用 result_filter 只取某一类结果，用 goggles 自定义排序。',
      '查询语法支持 site:、ext:、intitle:、"精确短语"、-排除词 等运算符。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索查询词。支持 site:example.com、-排除词、"精确短语" 等运算符。' },
        count: {
          type: 'integer',
          minimum: MIN_COUNT,
          maximum: MAX_COUNT,
          description: `返回结果数量，默认 ${DEFAULT_COUNT}，最大 ${MAX_COUNT}。实际条数可能少于请求值。`,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_OFFSET,
          description: '翻页偏移，默认 0。下一页把 offset 加 1（需配合相同的 count）。',
        },
        freshness: {
          type: 'string',
          description: '时效过滤：pd=一天内，pw=一周内，pm=一月内，py=一年内，或 YYYY-MM-DDtoYYYY-MM-DD 自定义区间。',
        },
        country: { type: 'string', description: '结果来源国家，2 位国家码（如 US、CN、DE）或 ALL，默认 US。' },
        search_lang: {
          type: 'string',
          description: '结果语言，语言码如 en、zh-hans、zh-hant、ja。中文必须写 zh-hans（简体）或 zh-hant（繁体），传 zh 会被上游拒绝。',
        },
        safesearch: {
          type: 'string',
          enum: SAFESEARCH_VALUES,
          description: '成人内容过滤级别，默认 moderate。',
        },
        result_filter: {
          type: 'array',
          items: { type: 'string', enum: RESULT_FILTERS },
          description: '只返回这些类型的结果，默认全部。可选值见 enum，常用来只要 news 或 videos。',
        },
        goggles: {
          type: 'string',
          description: '自定义排序规则，可传 GitHub 上托管的 goggle 地址，或内联规则（如 "$discard\\n$site=docs.python.org"）。',
        },
        extra_snippets: {
          type: 'boolean',
          description: '为每条结果额外返回最多 5 段摘录，默认 false。',
        },
        text_decorations: {
          type: 'boolean',
          description: '摘要里是否保留 <strong> 高亮标记，默认 false（便于直接阅读）。',
        },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function lines(...values) {
  return values.filter((value) => value && String(value).trim()).map((value) => String(value).trim());
}

function clampCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(parsed)));
}

function clampOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_OFFSET, Math.floor(parsed));
}

/**
 * 执行 web_search 工具。
 *
 * @param {object} args 模型传来的参数
 * @param {{baseUrl: string, apiKey: string}} config
 * @param {{timeoutMs?: number}} [options]
 */
export async function runWebSearch(args = {}, config, options = {}) {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

  const q = String(args.q ?? '').trim();
  if (!q) {
    return errorResult('web_search 需要非空的 q 参数。');
  }

  const freshness = args.freshness === undefined ? '' : String(args.freshness).trim();
  if (freshness && !FRESHNESS_VALUES.includes(freshness) && !/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(freshness)) {
    return errorResult('freshness 只能是 pd、pw、pm、py 或 YYYY-MM-DDtoYYYY-MM-DD。');
  }

  const safesearch = args.safesearch === undefined ? '' : String(args.safesearch).trim();
  if (safesearch && !SAFESEARCH_VALUES.includes(safesearch)) {
    return errorResult('safesearch 只能是 off、moderate 或 strict。');
  }

  const filters = Array.isArray(args.result_filter) ? args.result_filter : [];
  const invalidFilter = filters.find((item) => !RESULT_FILTERS.includes(item));
  if (invalidFilter) {
    return errorResult(`result_filter 不支持 ${invalidFilter}，可选值：${RESULT_FILTERS.join('、')}。`);
  }

  const count = clampCount(args.count);
  const offset = clampOffset(args.offset);

  const query = new URLSearchParams({ q, count: String(count) });
  if (offset > 0) query.set('offset', String(offset));
  if (freshness) query.set('freshness', freshness);
  if (safesearch) query.set('safesearch', safesearch);
  if (args.country) query.set('country', String(args.country).trim().toUpperCase());
  if (args.search_lang) {
    const raw = String(args.search_lang).trim().toLowerCase();
    query.set('search_lang', LANG_ALIASES[raw] ?? raw);
  }
  if (filters.length > 0) query.set('result_filter', filters.join(','));
  if (args.goggles) query.set('goggles', String(args.goggles));
  if (args.extra_snippets === true) query.set('extra_snippets', 'true');
  // 默认关掉 <strong> 高亮标记，避免摘要里混入标签
  query.set('text_decorations', args.text_decorations === true ? 'true' : 'false');

  try {
    const data = await webSearch(query, config, timeoutMs);

    const header = [];
    const altered = data?.query?.altered;
    if (altered && altered !== q) {
      header.push(`（查询已被拼写纠正为 "${altered}"）`);
    }

    const blocks = renderResults(data, RENDER_LIMITS);
    if (blocks.length === 0) {
      const hint = filters.length > 0
        ? `result_filter 限定了结果类型（${filters.join('、')}），可以放宽限制或换个说法再试。`
        : '可以换一个更宽泛或不同措辞的查询词。';
      return textResult(lines(`没有找到 "${q}" 的结果。${hint}`, ...header).join('\n'));
    }

    const footer = [];
    if (data?.query?.more_results_available && offset < MAX_OFFSET) {
      footer.push(`[还有更多结果，翻页请传 offset=${offset + 1}]`);
    }

    const body = [
      ...header,
      `"${q}" 的搜索结果：`,
      '',
      ...blocks.flatMap((block) => [block, '']),
      ...footer,
    ];
    return textResult(body.join('\n').trim());
  } catch (error) {
    return errorResult(`搜索失败：${error.message}`);
  }
}

/**
 * 按名字分发工具调用。
 *
 * @param {string} name
 * @param {object} args
 * @param {{baseUrl: string, apiKey: string}} config
 */
export async function callTool(name, args, config) {
  switch (name) {
    case 'web_search':
      return runWebSearch(args, config);
    default:
      return errorResult(`未知工具：${name}`);
  }
}

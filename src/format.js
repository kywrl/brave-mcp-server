/**
 * 把 Brave 的 JSON 响应渲染成模型好读的纯文本。
 *
 * 上游返回的字段有一半是给浏览器渲染用的（HTML 片段、日期对象、嵌套的
 * profile/meta_url），这里统一压平成「标题 / 链接 / 来源 / 摘要」结构，
 * 每条结果都保持同样的缩进，模型扫一眼就能定位。
 */

/**
 * 除 web 之外会随响应一起返回的纵向结果，按此顺序渲染。
 * discussions / faq 的字段结构和其余几类不同，各自有专门的渲染函数。
 */
const VERTICALS = ['news', 'discussions', 'faq', 'videos', 'locations'];

const VERTICAL_LABELS = {
  news: '新闻',
  discussions: '论坛讨论',
  faq: '常见问题',
  videos: '视频',
  locations: '地点',
};

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? match;
    const hex = code[1] === 'x' || code[1] === 'X';
    const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
    return Number.isFinite(value) && value > 0 ? String.fromCodePoint(value) : match;
  });
}

/**
 * discussions 纵向结果的 question / top_comment 是论坛原文，带 <p>、<br>、
 * &#39; 这类标记；其它纵向结果的 description 偶尔也有。统一清成单行纯文本，
 * 以免破坏每条结果的缩进。
 */
function plainText(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 丢掉空值、去掉行尾空白，方便用 filter(Boolean) 组装多行文本。
 *
 * 注意不能 trim 整个字符串：调用方常先拼好 `   ${url}` 这类带前导缩进的
 * 行，整串 trim 会把缩进一起吃掉。
 */
export function lines(...values) {
  return values
    .filter((value) => value && String(value).trim())
    .map((value) => String(value).replace(/\s+$/, ''));
}

/** 从 meta_url 或 URL 本身取出站点名，用于结果行尾的来源标注 */
function siteOf(item) {
  const hostname = item?.meta_url?.hostname || item?.profile?.long_name || item?.profile?.name;
  if (hostname) return String(hostname);
  try {
    return new URL(item?.url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 一条 web/news/videos 结果的通用渲染 */
function renderEntry(index, item) {
  const title = plainText(item?.title) || '(无标题)';
  const url = item?.url || '';
  const site = siteOf(item);
  const age = item?.age || (item?.page_age ? String(item.page_age).slice(0, 10) : '');
  const meta = [age, site].filter(Boolean).join(' · ');
  const publisher = item?.video?.publisher || item?.video?.creator || '';
  const duration = item?.video?.duration || '';
  const videoMeta = [publisher, duration].filter(Boolean).join(' · ');

  const snippets = Array.isArray(item?.extra_snippets) ? item.extra_snippets.map(plainText).filter(Boolean) : [];
  const body = lines(
    plainText(item?.description),
    videoMeta && `（${videoMeta}）`,
    ...snippets.map((text) => `· ${text}`),
  );

  return [
    `${index}. ${title}`,
    url && `   ${url}`,
    meta && `   ${meta}`,
    ...body.map((line) => `   ${line}`),
  ].filter(Boolean).join('\n');
}

function renderInfobox(data) {
  const results = data?.infobox?.results;
  if (!Array.isArray(results) || results.length === 0) return '';
  const items = results.slice(0, 2).map((item) => {
    const head = [plainText(item?.title), item?.url].filter(Boolean).join(' — ');
    const desc = plainText(item?.long_desc) || plainText(item?.description);
    return [head && `- ${head}`, desc && `  ${desc}`].filter(Boolean).join('\n');
  });
  return ['知识卡片：', ...items].join('\n');
}

function renderRadarSection(label, data, key, limit) {
  const results = data?.[key]?.results;
  if (!Array.isArray(results) || results.length === 0) return '';
  const items = results.slice(0, limit).map((item, index) => renderEntry(index + 1, item));
  return [`${label}：`, ...items].join('\n\n');
}

/** discussions 的正文在 item.data 里，字段名和其它纵向结果完全不同 */
function renderDiscussions(data, limit) {
  const results = data?.discussions?.results;
  if (!Array.isArray(results) || results.length === 0) return '';
  const items = results.slice(0, limit).map((item, index) => {
    const info = item?.data ?? {};
    const question = plainText(info.question) || plainText(item?.title) || '(无标题)';
    const forum = plainText(info.forum_name) || siteOf(item);
    const answers = Number.isFinite(info.num_answers) ? `${info.num_answers} 条回复` : '';
    const meta = [forum, answers].filter(Boolean).join(' · ');
    const comment = plainText(info.top_comment);
    return lines(
      `${index + 1}. ${question}`,
      meta && `   ${meta}`,
      item?.url && `   ${item.url}`,
      comment && `   高赞回答：${comment}`,
    ).join('\n');
  });
  return ['论坛讨论：', ...items].join('\n\n');
}

function renderFaq(data, limit) {
  const results = data?.faq?.results;
  if (!Array.isArray(results) || results.length === 0) return '';
  const items = results.slice(0, limit).map((item, index) => lines(
    `${index + 1}. Q: ${plainText(item?.question) || plainText(item?.title) || '(无问题)'}`,
    plainText(item?.answer) && `   A: ${plainText(item.answer)}`,
    item?.url && `   ${item.url}`,
  ).join('\n'));
  return ['常见问题：', ...items].join('\n\n');
}

/**
 * 渲染整个响应，返回按顺序排列的文本块，调用方决定怎么拼。
 *
 * @param {object} data Brave 的响应
 * @param {{web: number, discussions: number, faq: number, verticals: number}} limits 各区块最多取几条
 */
export function renderResults(data, limits) {
  const blocks = [];

  const infobox = renderInfobox(data);
  if (infobox) blocks.push(infobox);

  const web = data?.web?.results;
  if (Array.isArray(web) && web.length > 0) {
    const items = web.slice(0, limits.web).map((item, index) => renderEntry(index + 1, item));
    blocks.push(['网页结果：', ...items].join('\n\n'));
  }

  for (const key of VERTICALS) {
    const limit = key === 'discussions' ? limits.discussions : key === 'faq' ? limits.faq : limits.verticals;
    const block = key === 'discussions'
      ? renderDiscussions(data, limit)
      : key === 'faq'
        ? renderFaq(data, limit)
        : renderRadarSection(VERTICAL_LABELS[key], data, key, limit);
    if (block) blocks.push(block);
  }

  return blocks;
}

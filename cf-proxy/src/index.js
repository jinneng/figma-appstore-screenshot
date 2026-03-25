// Cloudflare Worker: Apple API 代理
// 允许 Figma 插件通过此 Worker 访问 itunes.apple.com 和 mzstatic.com

const ALLOWED_ORIGINS = [
  'https://www.figma.com',
  'https://figma.com',
  'null' // Figma plugin sandbox
];

const ALLOWED_HOSTS = [
  'itunes.apple.com',
  'apps.apple.com',
  'rss.marketingtools.apple.com',
];

// mzstatic.com 图片域名用通配符匹配
function isAllowedHost(hostname) {
  if (ALLOWED_HOSTS.includes(hostname)) return true;
  if (hostname.endsWith('.mzstatic.com')) return true;
  return false;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // /proxy?url=<encoded_url> 模式
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter', usage: '/proxy?url=https://itunes.apple.com/...' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    if (!isAllowedHost(parsed.hostname)) {
      return new Response(JSON.stringify({ error: 'Host not allowed', host: parsed.hostname }), {
        status: 403,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    try {
      const resp = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      const responseHeaders = new Headers(corsHeaders());
      // 透传 content-type
      const ct = resp.headers.get('content-type');
      if (ct) responseHeaders.set('Content-Type', ct);
      // 缓存 1 小时
      responseHeaders.set('Cache-Control', 'public, max-age=3600');

      return new Response(resp.body, {
        status: resp.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Fetch failed', detail: err.message }), {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};

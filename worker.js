/**
 * Cloudflare Worker — spring-sky-90bc.jlmackay.workers.dev
 *
 * GET  /digest   → Fetch all 5 RSS feeds + AI structured digest
 * GET  /talks    → Fetch dhammatalks.org main audio page HTML
 * GET  /ai?prompt=...   → Raw Llama prompt
 * GET  /traffic?lat=&lon=&radius=  → TomTom traffic incidents
 * POST /fuel     → NSW FuelCheck prices
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url  = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/digest')  return await handleDigest(env);
      if (path === '/talks')   return await handleTalks();
      if (path === '/ai')      return await handleAI(url, env);
      if (path === '/traffic') return await handleTraffic(request, url, env);
      if (path === '/fuel')    return await handleFuel(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// /digest — fetch all 5 RSS feeds + AI structured digest
async function handleDigest(env) {
  const RSS_SOURCES = [
    { name: 'ABC AU',      url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
    { name: 'BBC',         url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { name: 'Guardian AU', url: 'https://www.theguardian.com/australia-news/rss' },
    { name: 'Al Jazeera',  url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'SBS News',    url: 'https://www.sbs.com.au/news/feed' },
  ];

  const headlines = [];
  for (const src of RSS_SOURCES) {
    try {
      const r = await fetch(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
        cf: { cacheTtl: 1800 },
      });
      if (!r.ok) continue;
      const text = await r.text();
      let count = 0;
      const matches = [...text.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gis)];
      for (const m of matches.slice(1)) {
        const t = m[1]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (t && t.length > 20 && count++ < 6) {
          headlines.push(`[${src.name}] ${t}`);
        }
      }
    } catch(e) {}
  }

  let commentary = null;
  if (env.AI && headlines.length) {
    const headlineStr = headlines.slice(0, 30).map(h => '- ' + h).join('\n');

    const userPrompt = `Here are today's top news headlines from Australian and international sources:\n\n${headlineStr}\n\nUsing only these headlines, produce the structured dot-point digest as instructed.`;

    const systemPrompt = `You are a news summariser. Your only job is to read the provided news headlines and produce a structured dot-point digest. Do not interpret, editorialise, or explain why stories matter. Do not add concluding sentences. Do not write "These stories are significant because..." or any equivalent phrase.

Format your response exactly as follows — three sections in this order, each with a bold markdown heading and 3–5 dot points:

**Politics**
- [Australian federal politics, Australian state/territory politics, international politics]

**Markets & Economy**
- [ASX and Australian markets, US/EU global markets, RBA and interest rates, cost of living and inflation]

**Social**
- [Human interest and community stories only — exclude crime, accidents, crashes, disasters, and violence]

Rules:
- Each dot point is one factual sentence stating what happened. No opinion. No analysis.
- If a category has no relevant stories in the provided headlines, skip that section entirely.
- Do not include any introductory text before the first heading.
- Do not include any text after the last dot point.`;

    try {
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens: 700,
      });
      commentary = result?.response?.trim() || null;
    } catch(e) {}
  }

  return json({
    commentary,
    headlines:   headlines.slice(0, 30),
    generatedAt: new Date().toISOString(),
    aiAvailable: !!env.AI,
  });
}

// /talks — fetch dhammatalks.org main audio page, return HTML
async function handleTalks() {
  const r = await fetch('https://www.dhammatalks.org/audio/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    cf: { cacheTtl: 3600 },
  });
  if (!r.ok) return json({ error: `dhammatalks ${r.status}` }, 502);
  const html = await r.text();
  return new Response(JSON.stringify({ html }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// /ai?prompt=... — raw Llama prompt
async function handleAI(url, env) {
  if (!env.AI) return json({ error: 'AI binding not configured.' }, 500);
  const prompt = url.searchParams.get('prompt') || '';
  if (!prompt) return json({ error: 'prompt required' }, 400);
  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 1000,
  });
  return json({ response: result?.response || '' });
}

// /traffic?lat=&lon=&radius= — TomTom incidents
async function handleTraffic(request, url, env) {
  const lat    = parseFloat(url.searchParams.get('lat')    || '-33.8688');
  const lon    = parseFloat(url.searchParams.get('lon')    || '151.2093');
  const radius = parseFloat(url.searchParams.get('radius') || '50');
  const key    = env.TOMTOM_KEY;
  if (!key) return json({ error: 'TOMTOM_KEY not set' }, 500);
  const bbox = `${lon - radius/111},${lat - radius/111},${lon + radius/111},${lat + radius/111}`;
  const r = await fetch(
    `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${key}&bbox=${bbox}&fields={incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}&language=en-GB&t=1111&categoryFilter=0,1,2,3,4,5,6,7,8,9,10,11&timeValidityFilter=present`,
    { cf: { cacheTtl: 300 } }
  );
  if (!r.ok) return json({ error: `TomTom ${r.status}` }, 502);
  return json(await r.json());
}

// POST /fuel — NSW FuelCheck
async function handleFuel(request, env) {
  const key = env.FUELCHECK_KEY;
  if (!key) return json({ error: 'FUELCHECK_KEY not set' }, 500);
  const body = await request.json().catch(() => ({}));
  const { lat = -33.8688, lon = 151.2093, radius = 50, fueltype = 'E10' } = body;
  const r = await fetch('https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices/nearby', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': `Bearer ${key}`,
      'apikey':        key,
    },
    body: JSON.stringify({ fueltype, latitude: String(lat), longitude: String(lon), radius: String(radius), sortby: 'price', maxresults: 10 }),
    cf: { cacheTtl: 600 },
  });
  if (!r.ok) return json({ error: `FuelCheck ${r.status}` }, 502);
  return json(await r.json());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

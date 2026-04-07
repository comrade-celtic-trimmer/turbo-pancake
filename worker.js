/**
 * Cloudflare Worker — spring-sky-90bc.jlmackay.workers.dev
 *
 * GET  /digest   → Fetch all 5 RSS feeds + AI structured digest
 * GET  /talks    → Fetch dhammatalks.org main audio page HTML
 * GET  /ai?prompt=...   → Raw Llama prompt
 * GET  /traffic?lat=&lon=&radius=  → TomTom traffic incidents
 * GET  /fuel?lat=&lon=&radius=     → NSW FuelCheck prices (all types, merged by station)
 * GET  /camping?lat=&lon=&radius=  → Nearest campsites from seed data
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
      if (path === '/fuel')    return await handleFuel(url, env);
      if (path === '/camping') return await handleCamping(url);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

// ── /digest ───────────────────────────────────────────────────────────────────
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
    const systemPrompt = `You are a news summariser. Your only job is to read the provided news headlines and produce a structured dot-point digest. Do not interpret, editorialise, or explain why stories matter. Do not add concluding sentences. Do not write "These stories are significant because..." or any equivalent phrase.\n\nFormat your response exactly as follows — three sections in this order, each with a bold markdown heading and 3–5 dot points:\n\n**Politics**\n- [Australian federal politics, Australian state/territory politics, international politics]\n\n**Markets & Economy**\n- [ASX and Australian markets, US/EU global markets, RBA and interest rates, cost of living and inflation]\n\n**Social**\n- [Human interest and community stories only — exclude crime, accidents, crashes, disasters, and violence]\n\nRules:\n- Each dot point is one factual sentence stating what happened. No opinion. No analysis.\n- If a category has no relevant stories in the provided headlines, skip that section entirely.\n- Do not include any introductory text before the first heading.\n- Do not include any text after the last dot point.`;
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

// ── /talks ────────────────────────────────────────────────────────────────────
async function handleTalks() {
  const RSS_URLS = [
    'https://www.dhammatalks.org/rss/evening.xml',
    'https://www.dhammatalks.org/rss/morning.xml',
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml,application/xml,text/xml',
  };
  const results = await Promise.allSettled(
    RSS_URLS.map(url => fetch(url, { headers, cf: { cacheTtl: 3600 } }).then(r => r.ok ? r.text() : Promise.reject(r.status)))
  );
  const talks = [];
  const seen = new Set();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const xml = result.value;
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const [, item] of items) {
      const mp3 = (item.match(/<enclosure[^>]+url="([^"]+\.mp3)"/) || [])[1];
      if (!mp3 || seen.has(mp3)) continue;
      seen.add(mp3);
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      const duration = (item.match(/<itunes:duration>(.*?)<\/itunes:duration>/) || [])[1] || '';
      talks.push({
        title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
        mp3,
        pubDate,
        duration: parseInt(duration, 10) || 0,
        teacher: 'Thanissaro Bhikkhu',
      });
    }
  }
  if (!talks.length) return json({ error: 'dhammatalks unavailable' }, 502);
  return new Response(JSON.stringify({ talks }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── /ai ───────────────────────────────────────────────────────────────────────
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

// ── /traffic ──────────────────────────────────────────────────────────────────
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

// ── /fuel?lat=&lon=&radius= ───────────────────────────────────────────────────
// Fetches all fuel types from NSW FuelCheck and merges by station.
// Returns: { stations: [{ name, address, distance, prices: { E10, U91, P95, P98, DL } }] }
async function handleFuel(url, env) {
  const key = env.FUELCHECK_KEY;
  if (!key) return json({ error: 'FUELCHECK_KEY not set' }, 500);

  const lat    = parseFloat(url.searchParams.get('lat')    || '-33.8688');
  const lon    = parseFloat(url.searchParams.get('lon')    || '151.2093');
  const radius = parseFloat(url.searchParams.get('radius') || '10');

  // NSW FuelCheck only returns one fuel type per call.
  // We fetch all five in parallel and merge by station code.
  const FUEL_TYPES = ['E10', 'U91', 'P95', 'P98', 'DL'];

  const fetchType = (fueltype) =>
    fetch('https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices/nearby', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${key}`,
        'apikey':        key,
      },
      body: JSON.stringify({
        fueltype,
        latitude:   String(lat),
        longitude:  String(lon),
        radius:     String(Math.min(radius, 30)), // API cap: 30 km
        sortby:     'price',
        maxresults: 25,
      }),
      cf: { cacheTtl: 600 },
    }).then(r => r.ok ? r.json() : null).catch(() => null);

  const results = await Promise.all(FUEL_TYPES.map(fetchType));

  // Build station map keyed by stationcode
  const stationMap = {};

  results.forEach((data, i) => {
    if (!data) return;
    const fuelType = FUEL_TYPES[i];

    // Register stations we haven't seen yet
    (data.stations || []).forEach(s => {
      if (!stationMap[s.code]) {
        stationMap[s.code] = {
          id:       s.code,
          name:     s.name,
          brand:    s.brand,
          address:  `${s.address}, ${s.suburb}`,
          lat:      s.location?.latitude,
          lon:      s.location?.longitude,
          distance: haversine(lat, lon, s.location?.latitude, s.location?.longitude),
          prices:   {},
        };
      }
    });

    // Attach prices
    (data.prices || []).forEach(p => {
      // Map API codes to our display codes
      const typeMap = { E10:'E10', U91:'U91', P95:'P95', P98:'P98', DL:'DL', PDL:'DL' };
      const key2 = typeMap[p.fueltype] || p.fueltype;
      if (stationMap[p.stationcode]) {
        stationMap[p.stationcode].prices[key2] = p.price;
      }
    });
  });

  const stations = Object.values(stationMap)
    .filter(s => s.distance <= radius)
    .sort((a, b) => {
      // Sort by cheapest E10 (fallback to U91, then distance)
      const aPrice = a.prices.E10 ?? a.prices.U91 ?? 9999;
      const bPrice = b.prices.E10 ?? b.prices.U91 ?? 9999;
      return aPrice !== bPrice ? aPrice - bPrice : a.distance - b.distance;
    });

  return json({ stations });
}

// ── /camping?lat=&lon=&radius= ────────────────────────────────────────────────
async function handleCamping(url) {
  const lat    = parseFloat(url.searchParams.get('lat')    || '-33.8688');
  const lon    = parseFloat(url.searchParams.get('lon')    || '151.2093');
  const radius = parseFloat(url.searchParams.get('radius') || '50');

  const sites = CAMPING_DATA
    .map(s => ({ ...s, distance: haversine(lat, lon, s.lat, s.lon) }))
    .filter(s => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);

  return json({ sites });
}

// ── Haversine (km) ────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 9999;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── JSON helper ───────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Camping seed data ─────────────────────────────────────────────────────────
const CAMPING_DATA = [
  // Blue Mountains
  { name: 'Euroka Campground', lat: -33.7278, lon: 150.6342, tags: ['National Park', 'Toilets', 'Kangaroos'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/euroka-campground', availability: 'unknown' },
  { name: "Murphys Glen Campground", lat: -33.7869, lon: 150.4842, tags: ['National Park', 'Toilets'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/murphys-glen-campground', availability: 'unknown' },
  // Southern Highlands
  { name: 'Fitzroy Falls Campground', lat: -34.6412, lon: 150.4937, tags: ['National Park', 'Showers', 'Toilets'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/fitzroy-falls-campground', availability: 'unknown' },
  // Hunter Valley
  { name: 'Barrington Tops — Junction Pools', lat: -31.9753, lon: 151.4878, tags: ['National Park', 'Toilets', 'Swimming'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/junction-pools-campground', availability: 'unknown' },
  // South Coast
  { name: 'Ben Boyd NP — Bittangabee', lat: -37.1908, lon: 149.9547, tags: ['National Park', 'Toilets', 'Coastal'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/bittangabee-campground', availability: 'unknown' },
  { name: "Corrigan's Beach Campground", lat: -35.7158, lon: 150.2182, tags: ['National Park', 'Beach', 'Toilets'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/corrigans-beach-campground', availability: 'unknown' },
  // Central Tablelands
  { name: 'Abercrombie Caves Campground', lat: -34.0603, lon: 149.8214, tags: ['Toilets', 'Historic', 'Caves'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/abercrombie-caves-campground', availability: 'unknown' },
  // Snowy Mountains
  { name: 'Kosciuszko — Sawpit Creek', lat: -36.4558, lon: 148.3978, tags: ['National Park', 'Showers', 'Toilets', 'Dog-friendly'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/sawpit-creek-campground', availability: 'unknown' },
  { name: 'Kosciuszko — Riverbend', lat: -36.3872, lon: 148.4031, tags: ['National Park', 'Toilets', 'River'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/riverbend-campground-kosciuszko', availability: 'unknown' },
  // Illawarra
  { name: 'Budderoo NP Campground', lat: -34.6283, lon: 150.6892, tags: ['National Park', 'Toilets', 'Rainforest'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/budderoo-campground', availability: 'unknown' },
  // North Coast
  { name: 'Yuraygir — Illaroo', lat: -29.7418, lon: 153.2364, tags: ['National Park', 'Beach', 'Toilets'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/illaroo-campground', availability: 'unknown' },
  { name: 'Hat Head National Park', lat: -30.8723, lon: 153.0461, tags: ['National Park', 'Beach', 'Toilets'], booking_url: 'https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/hungry-gate-campground', availability: 'unknown' },
];

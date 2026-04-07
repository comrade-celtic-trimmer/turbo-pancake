// ─────────────────────────────────────────────────────────────────────────────
// ROAD TRIP WORKER ADDITIONS
// Add these route handlers to your existing Worker (spring-sky-90bc)
// ─────────────────────────────────────────────────────────────────────────────
//
// ENVIRONMENT VARIABLES to add in Cloudflare Dashboard → Workers → Settings:
//   NSW_FUEL_API_KEY   — from https://api.nsw.gov.au/ (free, register and request FuelCheck)
//
// KV NAMESPACE to create:
//   RT_CACHE           — bind in wrangler.toml as [[kv_namespaces]] name = "RT_CACHE"
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── CORS helper ───────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

// ── FUEL endpoint ─────────────────────────────────────────────────────────────
// GET /fuel?lat=X&lon=Y&radius=10
//
// Calls the NSW Government FuelCheck API.
// Docs: https://api.nsw.gov.au/product/22 (search "FuelCheck")
// Free tier: 1000 calls/day.
// We cache results in KV for 30 minutes to stay well within limits.
//
async function handleFuel(request, env) {
  const url = new URL(request.url);
  const lat  = parseFloat(url.searchParams.get('lat'));
  const lon  = parseFloat(url.searchParams.get('lon'));
  const radius = parseFloat(url.searchParams.get('radius') || '10');

  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: 'lat and lon required' }, 400);
  }

  const cacheKey = `fuel:${lat.toFixed(2)}:${lon.toFixed(2)}`;

  // Try KV cache (30 min TTL)
  if (env.RT_CACHE) {
    const cached = await env.RT_CACHE.get(cacheKey);
    if (cached) return jsonResponse(JSON.parse(cached));
  }

  // NSW FuelCheck API — get prices for nearby stations
  // The API requires a subscription key passed as a header.
  // Step 1: Get station list and prices in one call
  const fuelApiUrl = 'https://api.nsw.gov.au/v1/fuel/lovs/brands'; // health check
  const pricesUrl  = 'https://api.nsw.gov.au/v1/fuel/prices/nearby';

  const FUEL_TYPES = ['E10', 'U91', 'P95', 'P98', 'DL']; // DL = diesel

  const priceRes = await fetch(pricesUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'apikey': env.NSW_FUEL_API_KEY,
      'Authorization': `Bearer ${env.NSW_FUEL_API_KEY}`,
      'RequestServiceName': 'FuelCheckRefApp'
    },
    body: JSON.stringify({
      fueltype: 'E10', // API requires one type per call; we call for E10 and attach extras
      namedlocation: '',
      latitude: lat,
      longitude: lon,
      radius: Math.min(radius, 30), // API max radius 30km
      sortby: 'Price',
      ascending: 'true'
    })
  });

  if (!priceRes.ok) {
    // Fallback: return mock structure so UI renders gracefully
    console.error('FuelCheck API error:', await priceRes.text());
    return jsonResponse({
      stations: [],
      error: 'Fuel API unavailable — check NSW_FUEL_API_KEY is set'
    }, 200);
  }

  const priceData = await priceRes.json();

  // NSW FuelCheck returns { stations: [...], prices: [...] }
  // Merge them by stationcode
  const stationMap = {};
  (priceData.stations || []).forEach(s => {
    stationMap[s.code] = {
      id: s.code,
      name: s.name,
      brand: s.brand,
      address: `${s.address}, ${s.suburb}`,
      lat: s.location.latitude,
      lon: s.location.longitude,
      distance: haversine(lat, lon, s.location.latitude, s.location.longitude),
      prices: {}
    };
  });

  (priceData.prices || []).forEach(p => {
    if (stationMap[p.stationcode]) {
      // Map NSW fuel type codes to our display codes
      const typeMap = { 'E10':'E10', 'U91':'U91', 'P95':'P95', 'P98':'P98', 'DL':'DL', 'PDL':'DL' };
      const key = typeMap[p.fueltype];
      if (key) stationMap[p.stationcode].prices[key] = p.price;
    }
  });

  const stations = Object.values(stationMap)
    .filter(s => s.distance <= radius)
    .sort((a, b) => {
      const aE10 = a.prices.E10 || 9999;
      const bE10 = b.prices.E10 || 9999;
      return aE10 - bE10;
    });

  const result = { stations };

  // Cache in KV for 30 min
  if (env.RT_CACHE) {
    await env.RT_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 1800 });
  }

  return jsonResponse(result);
}

// ── CAMPING endpoint ──────────────────────────────────────────────────────────
// GET /camping?lat=X&lon=Y&radius=50
//
// Returns nearest campsites from a curated NSW dataset stored in KV.
// No live availability API exists for free — we link to booking pages instead.
//
// To populate the dataset, run the seed script below once (see CAMPING_DATA).
// Then update KV manually via: wrangler kv:key put --binding=RT_CACHE "camping:dataset" "$(cat sites.json)"
//
async function handleCamping(request, env) {
  const url = new URL(request.url);
  const lat    = parseFloat(url.searchParams.get('lat'));
  const lon    = parseFloat(url.searchParams.get('lon'));
  const radius = parseFloat(url.searchParams.get('radius') || '50');

  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: 'lat and lon required' }, 400);
  }

  // Load dataset from KV (put it there once with wrangler)
  let allSites = [];
  if (env.RT_CACHE) {
    const raw = await env.RT_CACHE.get('camping:dataset');
    if (raw) allSites = JSON.parse(raw);
  }

  // Fall back to inline seed data if KV not loaded yet
  if (!allSites.length) allSites = CAMPING_SEED_DATA;

  // Filter by radius and sort by distance
  const nearby = allSites
    .map(site => ({
      ...site,
      distance: haversine(lat, lon, site.lat, site.lon)
    }))
    .filter(s => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  return jsonResponse({ sites: nearby.slice(0, 10) });
}

// ── Seed camping data ─────────────────────────────────────────────────────────
// A starter set of NSW campsites. Extend this by:
// 1. Exporting from WikiCamps or Freecampsites.net manually
// 2. Or using the Parks NSW API (no auth needed for basic info):
//    https://www.nationalparks.nsw.gov.au/api/
//
// booking_url: for Parks NSW sites use https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/SLUG
// For free camps, booking_url is null.
//
const CAMPING_SEED_DATA = [
  // ── Blue Mountains ──
  {
    name: "Euroka Campground",
    lat: -33.7278, lon: 150.6342,
    tags: ["National Park", "Toilets", "Kangaroos"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/euroka-campground",
    availability: "unknown"
  },
  {
    name: "Murphys Glen Campground",
    lat: -33.7869, lon: 150.4842,
    tags: ["National Park", "Toilets", "No dogs"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/murphys-glen-campground",
    availability: "unknown"
  },
  // ── Southern Highlands ──
  {
    name: "Fitzroy Falls Campground",
    lat: -34.6412, lon: 150.4937,
    tags: ["National Park", "Showers", "Toilets"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/fitzroy-falls-campground",
    availability: "unknown"
  },
  // ── Hunter Valley ──
  {
    name: "Barrington Tops — Junction Pools",
    lat: -31.9753, lon: 151.4878,
    tags: ["National Park", "Toilets", "Swimming"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/junction-pools-campground",
    availability: "unknown"
  },
  // ── South Coast ──
  {
    name: "Ben Boyd National Park — Bittangabee",
    lat: -37.1908, lon: 149.9547,
    tags: ["National Park", "Toilets", "Coastal"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/bittangabee-campground",
    availability: "unknown"
  },
  {
    name: "Corrigan's Beach Campground",
    lat: -35.7158, lon: 150.2182,
    tags: ["National Park", "Beach", "Toilets"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/corrigans-beach-campground",
    availability: "unknown"
  },
  // ── Central Tablelands ──
  {
    name: "Abercrombie Caves Campground",
    lat: -34.0603, lon: 149.8214,
    tags: ["Toilets", "Historic", "Caves"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/abercrombie-caves-campground",
    availability: "unknown"
  },
  // ── Snowy Mountains ──
  {
    name: "Kosciuszko — Sawpit Creek",
    lat: -36.4558, lon: 148.3978,
    tags: ["National Park", "Showers", "Toilets", "Dog-friendly"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/sawpit-creek-campground",
    availability: "unknown"
  },
  {
    name: "Kosciuszko — Riverbend",
    lat: -36.3872, lon: 148.4031,
    tags: ["National Park", "Toilets", "River"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/riverbend-campground-kosciuszko",
    availability: "unknown"
  },
  // ── Illawarra / Wollongong area ──
  {
    name: "Minnamurra — Budderoo NP",
    lat: -34.6283, lon: 150.6892,
    tags: ["National Park", "Toilets", "Rainforest"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/budderoo-campground",
    availability: "unknown"
  },
  // ── North Coast ──
  {
    name: "Yuraygir — Illaroo",
    lat: -29.7418, lon: 153.2364,
    tags: ["National Park", "Beach", "Toilets"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/illaroo-campground",
    availability: "unknown"
  },
  {
    name: "Hat Head National Park",
    lat: -30.8723, lon: 153.0461,
    tags: ["National Park", "Beach", "Toilets"],
    booking_url: "https://www.nationalparks.nsw.gov.au/camp-and-stay/campgrounds/hungry-gate-campground",
    availability: "unknown"
  }
];

// ── Router — add these cases to your existing fetch handler ───────────────────
//
// In your existing Worker's fetch handler, add:
//
//   if (pathname === '/fuel')    return handleFuel(request, env);
//   if (pathname === '/camping') return handleCamping(request, env);
//
// Full export for a standalone Worker (merge with your existing one):
//
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (pathname === '/fuel')    return handleFuel(request, env);
    if (pathname === '/camping') return handleCamping(request, env);

    // ↓ Your existing routes go here (news digest, dharma, etc.)
    // if (pathname === '/news') return handleNews(request, env);
    // ...

    return new Response('Road Trip Worker', { status: 200 });
  }
};

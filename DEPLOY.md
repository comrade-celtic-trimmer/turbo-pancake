# Road Trip PWA — Deployment Guide

## Files to place in your repo

```
turbo-pancake/           ← repo root
├── index.html           ← main app (replaces dashboard/index.html)
├── manifest.json        ← PWA install metadata
├── sw.js                ← Service Worker (offline support)
├── icon-192.png         ← PWA icon
└── icon-512.png         ← PWA icon large
```

The old `dashboard/` folder can be deleted, or leave it — GitHub Pages
will just serve the new `index.html` from the repo root as your main page.

---

## Step 1 — Update your repo

```bash
cd ~/turbo-pancake

# Copy in the new files (or drag into GitHub web UI)
cp /path/to/index.html .
cp /path/to/manifest.json .
cp /path/to/sw.js .
cp /path/to/icon-192.png .
cp /path/to/icon-512.png .

git add .
git commit -m "Replace dashboard with Road Trip PWA"
git push
```

GitHub Pages will rebuild automatically. Done for the frontend.

---

## Step 2 — NSW Fuel Check API key

1. Go to https://api.nsw.gov.au/
2. Create a free account → My Apps → Add a new app
3. Subscribe to the **FuelCheck** API (it's free)
4. Copy your API key

Then add it to your Worker:

**Cloudflare Dashboard** → Workers & Pages → `spring-sky-90bc`
→ Settings → Variables → Add variable:

```
NSW_FUEL_API_KEY = <your key here>
```

Mark it as **Encrypted**.

---

## Step 3 — Create a KV namespace for caching

In your terminal (Wrangler must be logged in):

```bash
wrangler kv:namespace create RT_CACHE
```

Copy the ID it gives you. Add to your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RT_CACHE"
id = "PASTE_ID_HERE"
```

Then push the camping dataset to KV:

```bash
# The seed data is already in worker-additions.js as CAMPING_SEED_DATA
# To export it separately, run this once:
wrangler kv:key put --binding=RT_CACHE "camping:dataset" "$(node -e "
const data = require('./worker-additions.js'); // or paste the array
console.log(JSON.stringify(data.CAMPING_SEED_DATA));
")"
```

Or just leave it — the Worker falls back to the inline seed data if KV
is empty, so it will work without this step.

---

## Step 4 — Update your Worker

Open your Worker source (`~/turbo-pancake/` worker file or Cloudflare dashboard).

**Merge** the code from `worker-additions.js` into your existing Worker:

- Copy the `handleFuel()` and `handleCamping()` functions
- Copy the `CAMPING_SEED_DATA` array
- Add the two route cases to your existing `fetch()` handler:

```javascript
if (pathname === '/fuel')    return handleFuel(request, env);
if (pathname === '/camping') return handleCamping(request, env);
```

Then deploy:

```bash
wrangler deploy
```

---

## Step 5 — Test it

1. Open https://comrade-celtic-trimmer.github.io/turbo-pancake/
2. Allow location when prompted
3. Weather loads immediately (Open-Meteo, no key needed)
4. Fuel loads if NSW_FUEL_API_KEY is set correctly
5. Camping loads from seed data immediately

**On Android Chrome:** You'll see "Add to Home Screen" banner after ~30 seconds.
**On iOS Safari:** Tap Share → Add to Home Screen manually.
**Offline test:** Turn on airplane mode, reload — should show cached data.

---

## Extending the camping dataset

The seed data covers major NSW national park campgrounds. To add more:

### Option A — Manual additions
Add entries to `CAMPING_SEED_DATA` in `worker-additions.js`:

```javascript
{
  name: "My Favourite Spot",
  lat: -34.123,
  lon: 150.456,
  tags: ["Free", "No facilities"],
  booking_url: null,       // null = free/no booking
  availability: "unknown"  // always "unknown" unless you have live data
}
```

### Option B — Free camps dataset
Download from https://www.freecampsites.net/download/ (Australia dataset, free)
or export from WikiCamps AU (if you have a subscription).
Parse the CSV/JSON and push to KV:

```bash
node parse-sites.js > sites.json
wrangler kv:key put --binding=RT_CACHE "camping:dataset" "$(cat sites.json)"
```

### Option C — Parks NSW API (partial)
The national parks website exposes some data without auth:
https://www.nationalparks.nsw.gov.au/api/

This can give you campground names and links but not live availability.

---

## Availability status (the honest picture)

Real-time availability for Parks NSW requires their booking system (ParksConnect),
which has no public API. The current approach:

- Shows `availability: "unknown"` with a grey dot
- "Check availability →" links directly to the Parks NSW booking page for that site
- This is the most useful thing possible without a commercial API arrangement

If you later find a site with a public availability feed (some smaller parks use
their own booking systems), add a `fetchAvailability(site)` call in the Worker
and return `"available"` or `"unavailable"` accordingly.

---

## Weather — what triggers an alert

Alerts appear automatically when:
- Max temp ≥ 35°C → heat warning
- Min temp ≤ 0°C → frost warning
- Rain probability ≥ 70% → rain alert
- Rain sum ≥ 20mm → heavy rain alert

To adjust thresholds, edit the `if` conditions in `renderWeather()` in `index.html`.

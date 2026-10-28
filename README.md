# CanGo SG — Singapore bus & MRT web app

Live bus arrivals, trip planning, MRT disruption alerts, and a map. Installable on your phone's home screen.

**Try it:** https://cangosg.vercel.app

> The code is public so you can see what I'm building. It is not open source: all rights reserved (see `LICENSE`).

## Features
- **Trip planner** (bus + MRT) with *Now*, *Leave at* and *Arrive by* (late routes are flagged)
- **Bus only** switch for bus-only routes, and **📍 tap a stop** in a route to see it on the map
- **Traffic jam warnings** on bus routes near live LTA road incidents
- **Leave-now nudge**: compares your walk to the first stop against live bus ETAs (Leave now / Hurry / Leave in X min)
- **Map** (OneMap tiles): route lines coloured by MRT line, nearby stops you can tap
- **Buses near you** with live/scheduled labels, bus crowding dots, and buses you can't reach in time struck out
- **Favourites**: starred stops show live timings on open; saved places become one-tap chips (stored on the device)
- **MRT disruption mode**: routes avoiding the broken line come first, plus bus-only alternatives
- **Rain mode**: when NEA forecasts rain near you, routes with less walking are preferred
- **MRT platform crowd** levels on train legs, plus a tap-to-open **crowd forecast** chart (next 3 hours) with a "quieter from" tip
- **Live bus dots** on the map and a **bus approach strip** showing buses sliding towards your stop
- **Your trips**: tap "I'm taking this route" to log trips; monthly count, time on transit, estimated fares, most-taken routes (stored on the phone)
- **My commute**: save Home and Work, and the top card shows the best route and leave time (to work before 2 pm, home after)
- **Reliability signals**: "timing unstable" when a bus's ETA jumps or doesn't match its GPS; a banner when LTA's timing feed looks down, with usual frequencies from the timetable
- **Offline fallback**: last arrivals and routes are saved on the phone and shown with an "as of" time when there's no signal
- **Settings**: larger text, accessible travel (♿ wheelchair-accessible buses, less walking), fewer transfers
- **Long-transfer warnings** at big interchanges, and **Report a wrong timing** (pre-filled note + LTA feedback form)
- **Installable (PWA)**, opens instantly, auto-refreshes every 30 s, "updated X ago" labels
- API rate limiting so nobody burns through your quotas

## Structure
```
public/            what users load
  index.html       page + styles
  app.js           all front-end logic
  sw.js            service worker (offline shell, tile cache)
  manifest.webmanifest, icons/
  stops.json       built at deploy time (all bus stops, compact)
  services.json    built at deploy time (usual bus frequencies)
api/               serverless functions (keys stay here)
  arrivals, route, search, alerts, traffic, crowd, crowdforecast, weather, nearby (fallback)
scripts/build-stops.mjs   runs on each deploy to build stops.json
vercel.json        build + output settings
```

## Setup
1. **LTA DataMall key**: https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html (free)
2. **OneMap account**: https://www.onemap.gov.sg/apidocs/register (free)
3. Put this folder in a GitHub repo and import it into Vercel (Framework preset: **Other**; vercel.json sets the rest).
4. Environment variables in Vercel → Project → Settings → Environment Variables:
   - `LTA_ACCOUNT_KEY` (required, also used at build time for stops.json)
   - `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` (required for routing)
   - `DATAGOV_API_KEY` (optional, higher weather rate limit)
5. Redeploy. On your phone: open the site → Share → Add to Home Screen (iPhone) or tap **Install app** (Android).

Optional: Vercel → Analytics → Enable, to see usage. Vercel → Firewall → add a rate-limit rule on `/api/*` for stronger protection.

Bus stops rarely change, but redeploy every month or so to refresh stops.json.

## Things to verify on first deploy
- **Arrive by** sends `arriveBy=true` to OneMap. If OneMap ignores it, results depart at that time instead; the app still flags routes that arrive late.
- **MRT crowd tags** rely on OneMap returning station codes (e.g. `EW15`) for train legs. If it doesn't, the tags simply don't show.

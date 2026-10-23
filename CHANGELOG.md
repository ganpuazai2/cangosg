# Change log

Plain-language record of every change to the app, newest first.

## 2026-10-23

### Fix: settings couldn't be ticked
- **Bug:** on the Profile page, Larger text, Accessible travel, Fewer transfers and Vibrate on tap wouldn't stay ticked.
- **Cause:** the colour picker buttons were found by their `data-theme` label, but the whole page also carries that label (that's how the chosen colour is applied). So every click anywhere counted as "pick a colour", which re-applied the saved settings and unticked the box straight away.
- **Fix:** only the four colour buttons react now. Tested: all four switches tick and untick, and picking Sunset still works.
- **Offline cache:** the page and app code now load the newest version first and only use the saved copy when offline. This stops an old page (like the one still saying "Go SG") from showing after an update.
- Files: `public/app.js`, `public/sw.js` (offline cache `gosg-v19`)

### Uploaded to GitHub
- Code is now in a **private** GitHub repo: https://github.com/ganpuazai2/cangosg
- Checked before uploading: `.env` and the keys are not included.

### Live on the web 🎉
- Deployed on Vercel: **https://cangosg.vercel.app**
- Keys added in Vercel's Environment Variables (pasted from `.env`).
- Checked online: the app loads, live bus arrivals (e.g. 901M at Admiralty), place search, trip planning (Admiralty → Newton), MRT alerts, the full stop list and the install file all work.
- From now on, every change uploaded to GitHub goes live automatically.

### Renamed to CanGo SG
- New name **CanGo SG** everywhere: page title, header wordmark ("CanGo" with a small "SG" badge), home-screen app name, install button and reminder messages.
- Checked first: "CanGo" alone is used by a Sri Lankan taxi app (on both app stores) and others, so we went with "CanGo SG". `cangosg.vercel.app` looked free.
- Fixed: `public/manifest.webmanifest` (the file that makes the app installable) had been emptied by mistake during the colour update. It's restored, with the new name and teal colour.
- Files: `public/index.html`, `public/app.js`, `public/manifest.webmanifest`, `public/sw.js` (offline cache `gosg-v18`), `scripts/local-server.mjs`, `README.md`

### One-handed redesign: bottom tabs, thumb bar, sheets
The whole app is now laid out for use with one thumb. Main controls are in the bottom half of the screen.

**Navigation**
- **Bottom tab bar:** Home, Nearby, Favourites, Map, Profile. The active tab gets a soft pill behind its icon. The app remembers your tab while it's open.
- **Thumb bar** just above the tabs (on Home and Nearby): a big **🔍 Where to?** button and a round **↻ refresh** button.
- Nothing important sits in the top corners anymore. Settings and Install moved out of the header into Profile.
- Tap targets are at least 44–48 px; sheet buttons and tabs are 48 px or more.

**Screens**
- **Home:** "Your buses now" (nearest stop + saved stops). Friendly header: "Morning! ☀️ Let's get you moving", "Peak hour, give yourself a few extra min", "Still up? 🌙 Most buses are asleep".
- **Nearby:** big stop rows with distance and ›. Tapping one opens the **stop sheet**.
- **Stop sheet** (slides up from the bottom): full arrival board, plus a bottom action bar: ☆ Save, 🗺 Map, ↻, Done. Drag the handle down or tap outside to close.
- **Favourites:** reorder ↑ ↓, rename, remove saved stops; saved places; your trips.
- **Map:** full-height live map of nearby stops and gliding buses.
- **Profile:** accent colour, comfort and trip settings, install the app.
- **Where to?** opens the trip planner as a tall sheet. **Find routes** and ⇅ swap sit at the bottom. Starting ride mode closes the sheet.

**Glanceable bus rows**
- Bigger ETA numbers (50 px). **Green when the bus is ≤ 2 min away** and tracked live; amber for normal times; a range plus "unstable" when timing is shaky.
- Under each bus number: **bus type** (▣ Double, ▭ Single, Bendy) and **crowding** with shape, colour *and* a word (● Seats, ◐ Standing, ■ Full).
- "Leave now" is now **"Go now 🏃"**.
- **Swipe a bus row:** ← for a 🔔 reminder, → to 📌 pin. A coloured hint shows which action you're about to trigger.
- Buses **roll in** from the right, one after another, when a card first loads.
- **Live indicator:** "● Updated 12s ago" with a pulsing green dot; it turns amber when the data is over a minute old.

**Personality**
- **Illustrated empty states** with a little Singapore scene: HDB blocks, a tree and a bus driving past (sun by day, moon and lit windows at night). Used for "Where are you? 👋", no nearby stops, location off, no saved stops and the map before location is shared.
- Light micro-copy: "No buses right now. Even buses need a rest 😴".
- **Accent themes** in Profile: Teal (default), Orchid, Marina, Sunset. Each has light and dark versions.

- Tested every tab and sheet with real live buses at Admiralty, in light and dark mode.
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v17`)

### "Remind me" bus alerts (in-app)
- Tap a big countdown on a "Your buses now" card, or any bus row on a stop's arrival board. A sheet slides up: **"Remind me · Bus 913 at Admiralty Stn"** with **When it's 2 min away / 3 min / 5 min**.
- A yellow bar near the top shows active reminders ("🔔 Bus 913 · Admiralty Stn · buzz when 2 min away") with ✕ to cancel. The bus number on the card gets a small 🔔.
- The app checks every 15 s. When the bus is close enough: strong vibration, three beeps, a big **"🚌 Time to go!"** pop-up with "OK, going", and a phone notification if you allowed them.
- If the bus is already closer than you asked when you set it, the app tells you and reminds you for the **next** bus instead.
- Keeps the screen on while a reminder is active, because a web page pauses when the phone locks. The sheet says so plainly: "Keep Go SG open on screen… Alerts with your phone locked are coming later."
- Reminders expire after an hour.
- Tested with real buses at Admiralty: the sheet opened from a tap, and a reminder fired with the pop-up.
- `PLAN-free-and-paid.md`: expanded the Go SG Plus list (phone-locked alerts, daily commute alerts, reliability score per bus, best time to leave, monthly travel report, share my ride, etc.) and the "free = catch the bus, Plus = save time before you leave" rule.
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v16`, tapping a notification opens the app)

### Fixes from the competitor-complaints research
Based on the research into what users hate about MyTransport.SG, Moovit, SG Buses and SG BusLeh.

- **Honest timings on the home cards:** if a bus's timing has jumped or doesn't match its GPS, the card shows a range (e.g. "~4–7m") and an "unstable" tag instead of a falsely precise number. Screen readers hear "about 4 to 7 minutes, timing unstable".
- **Colourblind-safe crowding:** crowding now has a shape as well as a colour. ● filled circle = seats, ◐ half circle = standing only, ■ square = packed. Applies to the arrival boards and the home-card tracks. Hovering or holding a dot says "seats available" etc. The "What do these mean?" key is updated.
- **Manage saved stops:** a new "✎ Edit saved stops" button under "Your buses now". Move stops ↑ ↓ (that order is the home-screen order), give them a nickname like "Home stop" (the real name still shows underneath), or remove them with ✕.
- **Far-away saved stops** show "18.1 km away" instead of "18121 m · 242 min walk".
- **Calmer colours:** the header is now solid deep teal (#0D7377) with no stripes or glow, and the background gradient is gone. Buttons and highlights use the same teal (a lighter #4FD1C5 in dark mode). The amber LED clock stays.
- Tested with **real live buses** at Admiralty (913, 965, 969, 904…) and a saved stop at Blk 519A CP, in light and dark mode.
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v15`), `public/manifest.webmanifest`

### "Your buses now" home screen and live buses on the map
**Your buses now** (new top section, replaces the favourite stop cards):
- Shows your **nearest stop** first (📍 Nearest), then every stop you've ★ saved (★ Saved), as dark LED boards with big countdowns.
- Buses are sorted by soonest. Each shows the next bus large and the two after it small.
- A track under each bus shows the next three buses as dots sliding toward the 🚏, coloured by how full they are (green seats, amber standing, red packed).
- **"Leave now"** badge when the bus arrives within 2 minutes of the time it takes you to walk to the stop.
- **Press and hold a bus number to pin it** (a yellow bar fills while you hold; right-click on a computer). Pinned buses get a 📌 and show first. Once anything is pinned, the others fold behind "Show all". Saved on this phone, per stop.
- Shows 4 buses by default, with "Show all 5 buses" to see the rest.
- Tap the stop name to open its full board, approach strip and map below.
- Before location is allowed, it shows a "📍 Use my location" card instead.
- The old "Favourites" section is now **Saved places** (just the place chips).

**Live buses on the map:**
- When you look at a stop, the map moves into "Buses near you" and shows each next bus as a badge with its number and minutes (e.g. "969 3′"), coloured by crowding.
- Buses **glide** to their new GPS spot every 30 s instead of jumping, and creep toward the stop in between, at the pace their ETA suggests.
- A faint dashed line joins each bus to the 🚏 stop marker. Buses arriving within a minute pulse.
- Tap a bus for "Bus 969 · 3 min · 🟢 Seats available · Double deck · ♿". Its row on the board below lights up.
- When you plan a trip, the map moves back to "Plan a trip" and shows the route.
- Tested with simulated buses at Admiralty (real buses weren't running at 2 am): countdowns, dots, "Leave now", pinning and gliding markers all worked. **Still to check with real buses in the daytime.**
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v14`)

### LTA key added, live data switched on
- The LTA DataMall API Account Key arrived and is saved in `.env`.
- Built the full stop list: **5,209 bus stops** and **601 bus services** with usual frequencies (`public/stops.json`, `public/services.json`).
- Tested with real data (around 2 am): **nearby stops** (Admiralty Stn found 35 m away), **MRT alerts** (no disruptions), **platform crowd levels** and **traffic incidents** (e.g. roadworks on the PIE at Thomson Rd) all work.
- **Live bus arrivals** came back empty because buses had stopped for the night. To check after about 6 am.
- `scripts/build-stops.mjs` now reads `.env` by itself, so `node scripts/build-stops.mjs` works on this PC without extra steps.

## 2026-10-22

### Nicer, interactive map
- **Calmer background:** the light theme now uses OneMap's grey style, so coloured MRT lines and your route stand out. At night the dark map is dimmed and less saturated, so your route is the brightest thing on screen.
- **Route pins:** a green "A" pin at the start and a coral 🏁 pin at the end, both dropping in. A badge in the middle of each ride shows the line or bus number (e.g. "NS", "🚌 972M"). White dots mark where you board.
- **Tap a line on the map:** that part of the trip lights up, the rest fades, and the map zooms to it. A label shows e.g. "🚆 NS · 12 stops · 32 min, ADMIRALTY → NEWTON". The matching step in the route card highlights too. Tap empty map to show everything again.
- **Map buttons** on the right: ⤢ bigger map (fills most of the screen), + / − zoom, ⌂ show the whole trip, ◎ go to my location.
- **Small animations:** after the route draws, a glowing dot runs along it once. Your location dot pulses. A short "Tap a line on the map for details" hint fades away after a few seconds.
- Tested in a headless browser with Admiralty → Newton in light and dark mode. Tapping a leg highlighted it and its step.
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v13`)

### Fresh look and touch feedback
- **New colours:** a green-to-blue gradient header with a soft sun glow, a warm off-white background instead of flat grey, and a coloured marker on each section (yellow Favourites, green Plan a trip, blue Buses near you, coral Your trips). Gradient "Find routes" button. Dark mode updated to match.
- **Header greeting and clock:** "Good morning/afternoon/evening" with an amber LED clock. Shows "peak hour, expect crowds" at 7–9 am and 5–8 pm, and "most buses have stopped" after midnight.
- **Touch feedback:** every button squishes slightly and shows a ripple from your finger. Small buzz on tap (Android), which can be turned off in Settings → "Vibrate on tap".
- **Sliding switches:** in Now / Leave at / Arrive by and Bus + MRT / Bus only, the white highlight slides across instead of jumping.
- **Stars pop** when you save a favourite, with a small "★ Saved to favourites" message at the bottom.
- **Loading placeholders:** grey shimmering cards instead of "Loading…" text. Route results slide in one after another.
- Respects the phone's "reduce motion" setting.
- New `PLAN-free-and-paid.md`: research on what Transit, Citymapper, Moovit and Singapore bus apps charge for, and a proposed free vs "Go SG Plus" split.
- Files: `public/index.html`, `public/app.js`, `public/sw.js` (offline cache `gosg-v12`), `public/manifest.webmanifest`

### Small touches: pull to refresh, arrival pulse, swipe between routes
- **Pull to refresh:** drag down from the top of the page. A dark pill shows "Pull to refresh" → "Release to refresh" → "Refreshing…". It refreshes bus timings, MRT alerts and any routes on screen. Small buzz when it triggers.
- **Arrival pulse:** when a bus time changes, the LED number pops and glows amber. If a bus gets **later** (a delay), it flashes red instead, so a slipping bus stands out.
- **Swipe between routes:** swipe the chosen route card left or right to switch to the next or previous option. It slides in, and wobbles slightly when there are no more. On a computer, the arrow keys do the same. A small hint shows on phones.
- Respects "reduce motion" phone settings (animations are toned down).
- Tested in a browser with simulated touch: swipe left/right/end-of-list, pull-and-release refresh, countdown pulse vs delay pulse all worked.
- Files: `public/app.js`, `public/index.html`, `public/sw.js` (offline cache `gosg-v11`)

### Ride mode with "get off here" alerts
Idea from comparing against Moovit/Transit reviews: their best-loved feature is being told when to get off.

- After tapping "I'm taking this route", a new **▶ Start ride mode** button appears.
- A dark board slides up from the bottom (same amber LED style as the bus-stop arrival boards) and follows the trip step by step:
  - **Walking:** "210 m to go · Then board bus 972M at NEWTON STN EXIT A"
  - **On a bus or train:** "9 stops to go · Get off at NEWTON MRT STATION · about 20 min"
  - **One stop before:** "1 stop to go · Get off at the next stop. Press the bell". Phone vibrates and beeps.
  - **At your stop:** "Now · get off". Stronger vibration and beep, the board glows.
  - **At the end:** "🎉 You've arrived", then it closes by itself.
- Moves to the next step automatically as you walk and ride. There's also a **Next step ›** button and an **End ride** button.
- Underground on the MRT (no GPS), it estimates your position from the train timetable and says so.
- Keeps the screen on during the ride so the phone doesn't pause the app. GPS is only used during a ride, to save battery.
- Limits: works while the app is open on screen. A web app can't alert you from your pocket or the lock screen.
- Tested in a browser with a fake GPS moving along Admiralty → Newton: the stop countdown, alerts and step changes all worked.
- Files: `api/route.js` (sends each ride's full stop list), `public/app.js`, `public/index.html`, `public/sw.js` (offline cache `gosg-v10`)

### New features from user suggestions
Suggested list: waiting time, travel time, route, any jam, bus from A to B, fare, bus stop location.
Waiting time, travel time, route and fare were already in the app. Three new things fill the gaps:

- **"Bus only" switch** in Plan a trip (Bus + MRT / 🚌 Bus only). Shows routes that use only buses, with no MRT. Switching re-plans straight away.
  - Late at night (after the last bus) it says buses may have stopped, instead of showing an error.
- **Tap a stop to see where it is.** In a route's steps, the boarding stop or station now has a 📍 link. Tapping it zooms the map to that exact stop and labels it ("Board bus 969 here, ADMIRALTY STN").
- **Traffic jam warnings.** If an accident, roadworks, heavy traffic or a breakdown is within about 150 m of a bus route, the route card shows "🚧 Accident on bus 969's route: … Expect delays." Uses LTA's live traffic incidents, so it switches on once the LTA key is added. MRT legs aren't checked because trains aren't affected by road traffic.
- Small fix: pressing Enter on a button inside a route card (like "Crowd forecast") now works with a keyboard.
- **No more "Couldn't get routes (OneMap 404)" late at night.** When there's no bus + MRT route (usually because the MRT has closed), the app now searches bus-only routes on its own and shows them with a note: "🌙 No bus + MRT route right now (the MRT may have closed). Showing bus-only routes." If nothing runs at all, it gives a friendly message instead of an error.
- Files: `api/route.js`, `api/traffic.js` (new), `public/app.js`, `public/index.html`, `public/sw.js` (offline cache `gosg-v7` → `gosg-v9`)

### Moved the project from phone to PC
- Downloaded `sg-transit.zip` from the mobile claude.ai chat and unpacked it into this folder (app version 0.6.0, name still the placeholder "Go SG").
- Signed up for a OneMap account. Applied for an LTA DataMall key (still waiting for the email).
- Added `.env` to hold the keys on this PC (OneMap email and password filled in, LTA key still blank).
- Added `.gitignore` so `.env` never gets uploaded to GitHub.
- Added `scripts/local-server.mjs`, a small preview server so the app runs on this PC at http://localhost:3000 without Vercel. Start it with `node scripts/local-server.mjs`.
- Tested: place search, bus and MRT trip planning, and the map all work. Live bus timings wait for the LTA key.

### "I'm taking this route" can now be undone
- Tapping the button a second time removes that trip from "Your trips" and resets the button.
- After the first tap it reads "✓ Added to your trips · tap to undo".
- Files: `public/app.js`
- Bumped the offline cache version (`gosg-v6` → `gosg-v7`, in `public/sw.js`) so installed copies pick up the change.

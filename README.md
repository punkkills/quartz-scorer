# Quartz Dice Scorer

A phone-friendly end-of-game score tally for **Quartz: The Dice Game** (Lucky Duck Games, 3–6 players). Tap + and − to enter each player's crystals, and the standings update live.

No build step, no server, no dependencies: it's a static site. Open `index.html` in a browser or deploy the folder to any static host.

## Scoring rules implemented

| Crystal   | Value |
| --------- | ----- |
| Quartz    | $2    |
| Rubellite | $3    |
| Emerald   | $4    |
| Sapphire  | $5    |
| Ruby      | $7    |
| Amber     | $9    |

- **Set bonus** per color: 3 of a kind +3, 4 of a kind +6, 5 or more +10
- **Unstable crystals**: −3 each
- **Reckless Miner**: the player(s) with the fewest crystals in their chest lose 5
- **Tiebreak**: most Quartz, then Rubellite, and so on up the value ladder

Enter every crystal a player owns (cart and chest together), plus the chest count separately for the Reckless Miner penalty.

## Files

```
index.html             the whole app (HTML, CSS, JS)
manifest.webmanifest   name, colors and icons for "Add to Home Screen"
sw.js                  service worker for offline use
icons/                 app icons (SVG source + PNG sizes)
```

## Deploying

**GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / root. (Pages from a private repo needs a paid GitHub plan.)

**Netlify / Cloudflare Pages / Vercel:** connect the repo, leave the build command empty, set the output directory to the repo root. Works with private repos on free plans.

## Install on Android

Open the deployed URL in Chrome, tap ⋮, then **Install app** (or **Add to Home screen**). It launches full-screen with its own icon and works offline after the first visit.

## Making changes

When you change any app file, bump `VERSION` in `sw.js` (e.g. `v1` → `v2`). Otherwise installed copies keep serving the cached old version. After a deploy, close and reopen the app once or twice to pick up the update.

Game data is saved in the browser's `localStorage` on each device. It isn't synced between devices or between different site addresses.

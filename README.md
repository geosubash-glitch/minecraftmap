# Minecraft Progression Map

An interactive map of Minecraft progression, from the first oak log to the End.
Click any item to see what it requires and what it unlocks. Trace the full
recipe path to anything. Open the six deep-dive networks (enchantments,
animals, crops, potions, redstone and construction blocks).

Made by [Geo](https://www.behance.net/geosubash), Rishav & Adwaith.

## Using it

| | |
|---|---|
| Click an item | details, requirements and unlocks |
| Double-click / **Trace path** | the full path from raw resources |
| Dashed circles | open a network |
| `/` or `⌘K` | search every item, including inside networks |
| `Esc` | step back (close panel, clear filter, leave network) |
| `+` `−` `F` | zoom in, zoom out, fit |

Links are shareable: `#item/blaze_rod`, `#network/branch_potion`.

## Project layout

```
index.html              markup only
assets/css/app.css      styles
assets/js/data.js       all content: items, links, networks, tier colours
assets/js/app.js        the map (Cytoscape.js)
assets/js/intro.js      optional 3D intro (three.js, loaded lazily)
scripts/validate-data.js  data integrity checks (run in CI before deploy)
docs/REVIEW.md          design / engineering review and change log
```

## Editing content

All content lives in `assets/js/data.js`, one record per line. After editing:

```sh
node scripts/validate-data.js                 # structure
node scripts/validate-data.js --check-images  # also verify every icon URL
```

## Running locally

It is a static site. Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
```

Pushing to `main` validates the data and deploys to GitHub Pages
(`.github/workflows/static.yml`).

# Review & rework — Minecraft Progression Map

A top-to-bottom review of the site, stage by stage: data, architecture,
delivery, UI, interaction, accessibility, performance and operations. Each
finding lists its severity, what was wrong, and what changed.

Severity: **P0** breaks the product for some users · **P1** serious UX or
quality problem · **P2** polish or maintainability.

---

## 1. Data ("backend")

The site has no server. Its backend is the content dataset: 106 map items,
121 links and 6 networks holding 844 more items and 550 icon URLs.

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| D1 | P1 | **38 icon URLs returned 404** (spawn eggs, scutes, hyphae, slimeball, enchanted golden apple…). The asset source's `1.20.1` tag predates those items, so those nodes rendered as empty dark squares. | Each URL was re-pointed to a newer asset tag or to the correct texture name (`slime_ball`, `crimson_stem` for hyphae, and so on). 37 of 38 fixed; the Nautilus egg has no published texture, so it falls back to a flat colour tile on purpose. |
| D2 | P2 | A description was published with a self-correction still in it: *"2 planks + 3... actually 3 planks + 2 sticks."* | Fixed. |
| D3 | P2 | `degree`, which drives node size and hub placement, was computed inconsistently. Three items counted the dashed network link and the rest did not. | Normalised to item-to-item links only. The validator now enforces it. |
| D4 | P1 | There was **no validation**. One typo in an id would silently drop a link, or crash a network view. | Added `scripts/validate-data.js`. It checks duplicate ids, dangling links, self-loops, missing tier colours and labels, network root/anchor integrity and count mismatches. `--check-images` also sends a HEAD request to every icon. |
| D5 | P2 | 432 KB of JSON sat on a single line inside `index.html`, so every data edit produced an unreadable diff. | Moved to `assets/js/data.js`, one record per line. It is loaded as a script (not fetched), so the site still works when opened from disk. |

## 2. System design / architecture

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| S1 | P0 | **The whole app depended on two libraries it never used** (`dagre` and `cytoscape-dagre`). If either CDN request failed or was blocked, `cytoscape.use(cytoscapeDagre)` threw and the page stayed blank. | Removed both. The map uses its own preset layout and `cose`. |
| S2 | P1 | A single 557 KB file mixed markup, styles, data, app logic and a WebGL intro. | Split into `index.html`, `assets/css/app.css`, `assets/js/{data,app,intro}.js`. Each file is cached independently, so a data edit no longer invalidates the code, and vice versa. |
| S3 | P1 | Duplicated logic for the main map and the network view: two sizing functions, two texture switchers, two drift loops and two focus functions. They had already drifted apart. | One `MapView` factory serves both. |
| S4 | P1 | Highlight state was scattered. Hovering any node cleared an active search or tier filter, and typing a search while an item was pinned did nothing. | One `state` object (selection / trace / tier / query) and one `applyHighlight()` that re-derives every class. Hover is temporary and falls back to the underlying state. |
| S5 | P1 | Nothing was addressable: you couldn't link a friend to "Blaze Rod" or to the potions network. | Deep links: `#item/<id>` and `#network/<key>/<id>`. Browser Back closes a network. A "Copy link" button is in the details pane. |
| S6 | P2 | Network layouts used `randomize: true`, so each network looked different every time it opened. | Deterministic seed positions. The layout is cached per session, so reopening a network is instant. |

## 3. Delivery / performance

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| P1 | P1 | three.js (~600 KB) was downloaded on every visit, only to power the intro. | Loaded lazily, and only when the intro actually plays. |
| P2 | P1 | Scripts in `<head>` were render-blocking. | All scripts use `defer`. |
| P3 | P1 | The drift animation ran at 60 fps for the whole session: behind the intro, while a network covered the map, and for users with reduced motion. On the 510-node network it dropped to about 20 fps. | Only the visible map drifts. It can be turned off in the menu (the setting persists), honours `prefers-reduced-motion`, and pauses on maps with more than 250 nodes (now a steady 60 fps). |
| P4 | P2 | The intro's WebGL context was never released. | The renderer, textures and geometry are disposed when the intro ends. |
| P5 | P2 | Six font weights plus Fira Code were requested; three weights are used. | Reduced to Reddit Sans 500/600/700. |
| P6 | P2 | The canvas `font-family` value was invalid (the quotes were rejected), so map labels used a fallback font. | Fixed, and labels are redrawn once the web font has loaded. |

## 4. UI (visual)

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| U1 | P1 | Secondary text was white at 35% opacity (about 3:1 contrast), and "Base resource" was `#555` on near-black. Both fail WCAG AA. | Contrast tokens raised to about 5:1 and 9:1. |
| U2 | P1 | On phones, the details panel and path panel occupied the same spot at the top and overlapped. | Under 640 px, details are a bottom sheet, and tracing a path takes over that sheet. |
| U3 | P1 | On portrait phones the map was a thin horizontal strip across the middle of the screen. | On portrait screens the progression spine runs top to bottom. |
| U4 | P2 | Relationship lists were plain text with no icons. | Each related item is a row with its icon and the relation type (craft, smelt, mine…). |
| U5 | P2 | No favicon (a 404 on every load), no meta description or social preview, no `lang`. | Added. |

## 5. UX / interaction design

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| X1 | P0 | **The intro was a gate with no exit.** Nothing said you had to scroll, and there was no Skip button. Keyboard-only users could not get past it at all, and neither could anyone whose three.js download failed (the overlay stayed forever). | Skip button (focused on load), an on-screen hint with progress dots, arrow keys, Space, Enter and Esc, and auto-advance when idle. The intro is skipped automatically for returning visitors, deep links and reduced-motion users, and falls through to the map if WebGL or three.js is unavailable. "Replay intro" is in the menu. |
| X2 | P1 | The map's entrance animation played underneath the intro overlay, so nobody ever saw it. | It now plays as the intro fades out. |
| X3 | P1 | Search only dimmed the map. There was no list, Enter did nothing, and items inside the six networks (844 of the 950 items) were unsearchable. | A proper combobox. It shows ranked results with icons and where each item lives, supports ↑ ↓ Enter Esc, and choosing a result flies to the item (opening its network if needed). Focus it with `/` or ⌘K. |
| X4 | P1 | "Trace full path" was available only by double-clicking, which is undiscoverable and awkward on touch. | "Trace path" button in the details pane. Path steps are clickable and fly the camera to each step. |
| X5 | P1 | The tier legend opened on hover only, which doesn't work on touch or keyboard. There was no way to clear a filter, and clicking tiers that exist only inside networks did nothing. | It is a button-driven panel. It shows only the tiers present on the current map (with counts), marks the active filter on the button, and has a Clear action. |
| X6 | P2 | The menu held a single item that duplicated "Fit View", and the "always show icons" override mentioned in the code had no control. | The menu has Reset view, Always show item icons, Floating motion, Replay intro, a short how-to with shortcuts, and credits. |
| X7 | P2 | Selecting an item could leave it hidden under the details panel. | The camera frames the selection (or the whole traced path) inside the part of the screen no panel covers. |
| X8 | P2 | Zooming required a wheel or pinch. | + / − buttons and keys, plus F to fit. |
| X9 | P2 | In a network there was no way back except ×, and search was unavailable. | "← Map" back button, browser Back support, and search and menu stay available inside networks. |

## 6. Accessibility

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| A1 | P0 | `user-scalable=no, maximum-scale=1` disabled pinch-zoom for low-vision users (WCAG 1.4.4). | Removed. The map canvas keeps `touch-action: none`, so map gestures are unaffected. |
| A2 | P1 | Close buttons, the menu button and legend items were `<span>`s and `<div>`s: not focusable, not announced. | All real `<button>`s with labels, `aria-expanded` and `aria-pressed`. The menu supports arrow keys. |
| A3 | P1 | The map was a canvas with no non-visual path. | Search plus the details pane form a full keyboard and screen-reader route: find any item, read its description, and move through what it requires and unlocks. Selections are announced through a live region. |
| A4 | P2 | No focus indication anywhere. | `:focus-visible` rings throughout. |
| A5 | P2 | Motion was forced on everyone. | `prefers-reduced-motion` is honoured everywhere, and motion can be switched off in the menu. |

## 7. Operations

| # | Sev | Finding | Change |
|---|-----|---------|--------|
| O1 | P1 | The deploy workflow published whatever was on `main` with no checks. | A `validate` job runs `scripts/validate-data.js` on every push and pull request. Deploy depends on it. |
| O2 | P2 | A CDN outage meant a blank page. | A friendly error state with a Reload button, and a `<noscript>` message. |

---

## Not changed (deliberately), and follow-ups

- **Look and feel.** The dark glass palette, the constellation layout, the
  flat-dot-to-icon switch on zoom, the floating motion and the intro's block
  sequence are the authors' design and were kept.
- **Icons are hot-linked** from `raw.githubusercontent.com`. Self-hosting a
  sprite sheet would remove about 550 requests and the third-party dependency.
  That is worth doing if the site gets real traffic.
- **cytoscape from cdnjs** could be vendored into `assets/` to remove the last
  runtime CDN dependency. Subresource integrity (SRI) hashes are another option.
- **Large networks** (Construction Blocks, 510 items) take about 0.7 s to lay
  out the first time. Precomputing positions at build time would make it
  instant.

# MessageLoggerRevenge

A persistent deleted/edited message logger for **Revenge Classic** (Vendetta-compatible),
rebuilding the useful parts of MessageLoggerV2 for React Native: durable logs that
survive restarts, a browsable log UI, and local attachment caching.

## Why this exists

The existing mobile logger doesn't persist across reboots and has no log UI. This one
shards logs to disk per channel, keeps a lightweight index for fast browsing, and
caches attachment bytes locally so deleted media survives the CDN URL expiring.

## Architecture — the adapter split

Everything that touches Discord internals / the RN bridge lives behind one interface
so the eventual Revenge Next port is an afternoon, not a rewrite.

```
src/
  adapter/
    types.ts      # the Adapter contract (the seam)
    classic.ts    # the ONLY file importing vendetta.* — Classic implementation
  core/           # platform-agnostic; imports adapter/types only
    schema.ts     # versioned log data shapes
    store.ts      # sharded, debounced persistence + index
    cache.ts      # attachment capture (CDN race + proactive) + LRU eviction
    logger.ts     # dispatcher -> store/cache orchestration
  ui/             # React Native; toolkit injected via adapter
    LogViewer.tsx # channel index -> per-channel deleted/edited tabs
    Settings.tsx  # toggles, watched-guild editor, "open log" button
  index.tsx       # wiring + Vendetta lifecycle (onLoad/onUnload/settings)
```

**Port to Next:** write `adapter/next.ts` implementing the same `Adapter`, change the
single import in `index.tsx`. `core/` and `ui/` don't move.

## Design notes

- **No localhost server.** On desktop, MLV2 needed one to bridge disk cache into the
  DOM. RN has no such wall — an `<Image>` loads `file://` from the app sandbox directly,
  so the cache manager just writes bytes and hands back a path.
- **Binary safety.** Attachments cross the native bridge as base64, not UTF-8 text, so
  there's no analogue of the desktop fs-shim corrupting image bytes.
- **Bursty writes.** Bulk deletes (purges) coalesce into one debounced flush per channel.

## Build & install

You need Node.js (v18+). Then, from the extracted folder:

```bash
npm install        # one time — pulls esbuild + typescript
npm run serve      # builds dist/, watches src/, serves over your LAN
```

`npm run serve` prints the port (4040). Find your computer's LAN IP:
- Windows: `ipconfig` → "IPv4 Address" (e.g. 192.168.1.20)
- macOS/Linux: `ip addr` or `ifconfig`

Your phone and computer must be on the **same Wi-Fi network**.

In Discord (Revenge), go to the **Plugins** page → **install from URL** and enter:

```
http://<your-LAN-ip>:4040/
```

Keep the trailing slash — the client appends `manifest.json` to it. Enable the
plugin, then open its settings and tap **Run self-check** first (see below).

> Note: this is the *Plugins* install flow. Do **not** use Settings → Developer →
> "Load from custom URL" — that replaces Revenge's entire core bundle, which is a
> different feature and not what you want here.

### Iterating

Leave `npm run serve` running. When you edit a file under `src/`, it rebuilds and
restamps the manifest hash. Back in Discord, disable/re-enable the plugin (or
reload) to pull the new bundle — the hash change is what triggers the re-download.

### One-shot production build

```bash
npm run build      # outputs dist/ (index.js + manifest.json)
```

You can then host the `dist/` folder anywhere static (GitHub Pages, etc.) and
install from that URL instead of your LAN.

## First run: the self-check

The native file API's method names vary across Revenge builds, so before trusting
the logger, open the plugin's settings and tap **Run self-check**. It reports:
- whether navigation and the message/channel stores resolved,
- the documents directory path,
- a live write→read→delete round-trip (`file round-trip: true` means persistence
  works on your build),
- the actual `FileModule` method names available.

If the round-trip is `false` or logging misbehaves, send me that self-check output
— it tells us exactly which adapter method names need adjusting in
`src/adapter/classic.ts`, and nothing in `core/` or `ui/` has to change.

## Status: v0.1.0 skeleton

Working: dispatcher hooks, persistent sharded store, settings, log viewer, cache
manager with CDN-race + proactive caching + LRU.

Not yet: message-jump from a log entry, search/filter within a channel, edit-diff
highlighting, export. These slot into `ui/` without touching core.
```

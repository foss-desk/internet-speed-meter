# Code Audit — Internet Speed Meter 1.6.0

Reviewed: every file under `src/`, the GSettings schema and the `Makefile`, as of
commit `4bed937`. Each finding below is followed by its status. The fixes are in the
working tree (not committed yet) and listed under `[Unreleased]` in `CHANGELOG.md`.

**Status: all 32 items fixed.** One more problem turned up while testing and is fixed
too (2.7). The two items first left open ("Current Session" resetting on unlock, and the
accent CSS) were done in a second pass.

---

## How the fixes were checked

| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | passes |
| `make check`: 17 unit tests for the pure functions in `tests/run.js`, including the per-interface delta cases from 1.2 | 17/17 pass |
| `make pack` + `shexli` (local approximation of the EGO review) | clean, 0 findings |
| `glib-compile-schemas --strict` | passes |
| Isolated headless GNOME Shell (own XDG dirs and bus): enable, open the menu, open the speed test page, close, disable, enable again | extension `ACTIVE` throughout, no JS errors or warnings in the shell log, `stats.json` written on disable; the dashboard showed connection, local and public IP, quality badge, panel speed and today's total |
| `gsettings set … refresh-interval 0` in that shell | rejected: "outside of the valid range" |
| `isPhysicalInterface` on this machine | `enp3s0` counted; `lo`, `docker0`, 4× `br-*` and 5× `veth*` left out (the old code counted all of them) |
| Real speed test through `SpeedTest` in gjs (Dhaka server, gigabit link) | ping 2.3 ms; download ≈ 890 Mbps; upload ≈ 755 Mbps; `cancel()` after 2.5 s rejects with `G_IO_ERROR_CANCELLED` at 2.50 s |
| "Current Session" across disable/enable (what a screen lock does) in the headless shell | 599.1 KB before, 1.48 MB after: kept counting |
| Accent colors read back from St theme nodes in the headless shell (GNOME 50.1), teal and yellow, dark and light | derived with the old rules: bar alpha 30/255 ≈ 0.12; light-mode text = accent mixed 55 % with black (teal `#2e7e7c` → `#194544`); switching back to blue removes the class and restores the original look |

Not tested: the real look of the panel and popup on screen (colors were read from the theme, but there are no screenshots), GNOME 45–49, a real
VPN, an IPv6-only network, battery switching, and a corrupt `stats.json`. Those paths
were checked by reading the code only.

---

## 1. Bugs

### 1.1 Traffic double-counted while a VPN, Docker or a bridge is up — High · **Fixed**
`indicator.ts` summed every interface except `lo`, so tunnel and container traffic was
counted again on the uplink.

**Done:** `isPhysicalInterface()` in `network.ts` (sysfs `device` link, plus `ppp*`).
With `monitored-interface` empty, only hardware interfaces are counted. The set is
rebuilt only when the interface names in `/proc/net/dev` change. If a system has no
hardware interface at all (containers, some VMs), it falls back to everything except
`lo`. The schema description now says this.

### 1.2 Changing the monitored interface added a fake spike — High · **Fixed**
The summed counters of the old interface set were compared with the new one.

**Done:** `trafficDelta()` in `network.ts` compares counters per interface. An
interface that is new, renamed, newly monitored or has restarted its counter
contributes nothing until its second sample. Unit-tested, including "switching the
monitored interface adds no spike" and "a vanished interface does not hide traffic on
the others".

### 1.3 Nothing recorded at a 5000 ms refresh interval — High · **Fixed**
The fixed 5 s gap limit was below the real gap.

**Done:** the limit is now 3 × the current (battery-clamped) interval
(`MAX_SAMPLE_GAP_INTERVALS`).

### 1.4 No schema ranges; `refresh-interval = 0` busy-looped the shell — Medium · **Fixed**
**Done:** `<range>` on `refresh-interval` (500–5000), `idle-threshold-kb` (1–500) and
`data-quota-gb` (0–10000), matching prefs. `make build` now compiles schemas with
`--strict`. Checked in a live shell.

### 1.5 Quota notifications came back after every unlock — Medium · **Fixed**
**Done:** new hidden key `quota-notified` (`"YYYY-MM:80"` / `"YYYY-MM:100"`). Each level
fires once per calendar month, across locks, logins and restarts. The three in-memory
flags are gone.

### 1.6 A corrupt `stats.json` was overwritten with an empty history — Medium · **Fixed**
**Done:** on any load error other than "file not found", the file is renamed to
`stats.json.bad` before loading continues. If even the rename fails, the manager stays
unloaded and never saves over it.

### 1.7 Lock/unlock could lose up to a minute of traffic — Low · **Fixed**
**Done:** module-level `lastWrite` promise in `stats.ts`; `_load()` waits for it.

### 1.8 Speed-test requests outlived their phase — Medium · **Fixed**
**Done:** each phase (server pick, latency, download, upload) runs in `_phase()`, with
its own `Gio.Cancellable`. That cancellable is linked to the test's and cancelled as
soon as the phase ends. `measureLatency` sends one unrecorded warm-up ping first.

The audit first suggested `Soup.Session.abort()`. Testing showed that abort cancels
the caller's own cancellable for every pending request, which aborted the whole test.
That is noted in CLAUDE.md so nobody tries it again.

### 1.9 Throughput under-reported — Medium · **Fixed**
**Done:** download uses `send_async` and reads 64 KiB at a time, counting bytes as they
arrive. Upload counts through Soup's `wrote-body-data` signal. Only bytes between 1 s
(after TCP ramp-up) and the deadline count. The phase ends exactly at the deadline,
not up to 2 s after it.

### 1.10 Auto-hide hid the whole button — Low · **Fixed**
**Done:** while idle, a `network-transmit-receive-symbolic` icon replaces the numbers
(inside one container, since `PanelMenu.Button` only allocates its first child). The
menu stays reachable. Prefs subtitle updated to match.

### 1.11 Smaller correctness items
| Item | Status |
|---|---|
| `updateAppUsage` before load wrote into a history about to be replaced | **Fixed**: ignored until loaded |
| Public IP not validated (captive portal HTML) | **Fixed**: `GLib.hostname_is_ip_address()` |
| First quality sample included the TLS handshake | **Fixed**: one unrecorded warm-up request when the menu opens |
| IPv4 only (IPv6-only showed "Disconnected") | **Fixed**: `parseDefaultRoute6()` fallback (unit-tested) and IPv6 local address |
| Overlapping `_updatePowerState()` calls could apply a stale answer | **Fixed**: request counter |
| "Current Session" reset on every unlock | **Fixed**: the counter is two numbers at module scope (`sessionTraffic` in `indicator.ts`). The module stays loaded for the whole shell process, so the count survives lock/unlock and resets only on a new login. No new setting was needed, and the Reset button still clears it. |

---

## 2. Bottlenecks and optimizations

| # | Where | Status |
|---|---|---|
| 2.1 | 6 GSettings reads per tick | **Fixed**: cached in fields by `_readSettings()`, refreshed on `changed` |
| 2.2 | Extra D-Bus `Get` on every UPower `PropertiesChanged` | **Fixed**: `OnBattery` read from the signal payload; `Get` only at start and when the setting changes |
| 2.3 | New zero-filled upload buffer (up to 4 MB) per request | **Fixed**: one `GLib.Bytes` per size per test |
| 2.4 | New `PangoLayout` + `FontDescription` per text draw | **Fixed (fonts)**: font descriptions cached per size; the layout must still be created per Cairo context |
| 2.5 | Overlapping `_tick` reads | **Fixed**: `_reading` guard |
| 2.6 | `JSON.stringify` of the full history every 60 s just to compare | **Fixed**: `_dirty` flag; nothing serialized while idle |
| 2.7 | *New, found while testing:* with streaming byte counts, `onProgress` fired ~40,000 times in a 7 s download on a gigabit link, and each call sets two St labels | **Fixed**: throttled to 10 updates a second (`PROGRESS_INTERVAL_SECS`); measured 30 updates in a 4 s run |

---

## 3. GNOME review guidelines

Already fine (unchanged): lifecycle created in `enable()` and destroyed in
`disable()`, `_releaseResources()` cleanup, `connectObject`, no subprocesses, no
deprecated modules, process separation, network disclosure, `shell-version` 45–51,
`make pack` exclusions.

| Item | Status |
|---|---|
| Schema ranges | **Fixed** (1.4) |
| `prefs.ts` `visible_page` override | **Kept, comment shortened to one line.** It works around a real GNOME 50 warning that its author saw; removing it can't be verified without that setup. If a reviewer objects, remove the `Object.defineProperty` block; nothing else depends on it. |
| `logError` → `console.error` | **Fixed** everywhere; works on 45–51 |
| New network use | None. The speed test sends the same kind of requests as before (now cancelled sooner), and the quality probe sends one extra request when the menu opens. The `metadata.json` description is still accurate. |

---

## 4. Code that reads as hand-written

| Item | Status |
|---|---|
| All-caps msgids (`EXCELLENT`, `MEASURING...`) | **Fixed**: `Excellent`/`Good`/`Fair`/`Poor`, `Measuring…` |
| "Speedtest" vs "Speed Test" | **Fixed**: "Speed Test" everywhere |
| Feature-list prefs titles and descriptions that only repeat the title | **Fixed**: "Display", "General", "Panel", "History", "Data Quota", "Export", "Save Power on Battery"; repeated group descriptions removed |
| Makefile banners and `▸`/`✔` | **Fixed**: plain comments and messages |
| 41 `accent-*` CSS selectors (9 near-identical blocks) | **Fixed**: replaced with one 6-rule block on a single `speed-meter-accent` class, using St's `-st-accent-color` and its color functions (`st-lighten`, `st-darken`, `st-mix`, `st-transparentize`). The old hand-picked shades turned out to follow fixed rules (text lightened 15 % on dark, mixed 55 % with black on light, gradient end darkened 7 %, bar at 12 % alpha), and those rules are now applied to the real accent. The JS no longer keeps its own list of accent names. Stylesheet: 928 → 842 lines. |

How the accent class is applied: only on GNOME 47+ (the `accent-color` setting and St's
accent support both arrived in 47) and only when the accent is not blue. Blue keeps the
tuned default styling, and 45–46 never see the new CSS. One side effect is an
improvement: distributions that ship their own accent palette (this test system's
teal is `#2e7e7c`, not Adwaita's `#2190a4`) now get the shell's actual accent instead of
hard-coded Adwaita colors. Any accent GNOME adds later also works without changes.

There were no translations yet (`po/` only had the template), so changing msgids broke
nothing. `make pot` has been rerun.

---

## 5. Build and tooling

| Item | Status |
|---|---|
| `make test` enabled the extension in the **host** shell and used the real dconf | **Fixed**: isolated XDG dirs in `.test-home/` (gitignored), with `gnome-extensions enable` run inside the nested session's bus |
| `npm install` on every build, lockfile gitignored | **Fixed**: `npm ci`; `package-lock.json` removed from `.gitignore` (it was listed twice) and now shows as untracked, ready to commit |
| No tests | **Fixed**: `tests/run.js` + `make check`; gjs only, no shell needed |

README, CLAUDE.md and CHANGELOG were updated to match (`make check`, the new `make test`,
`quota-notified`, the per-interface counting and the `Soup.Session.abort()` gotcha).

---

## Before releasing

1. Look at the panel and popup in a real session (`make test`): the idle icon, the
   quality badge in normal case, and a non-blue accent in both light and dark style.
2. Commit, including `package-lock.json` and `tests/`.
3. ~~Bump the version~~ Done: 1.7.0 in `package.json`, `package-lock.json` and `metadata.json`, and `[1.7.0] - 2026-11-23` in the changelog. Upload the zip from `make pack` to extensions.gnome.org.

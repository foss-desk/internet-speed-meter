<p align="center">
  <a href="https://extensions.gnome.org/extension/9828/internet-speed-meter/">
    <img src="https://img.shields.io/badge/GNOME_Extensions-9828-4A86CF?style=for-the-badge&logo=gnome&logoColor=white" alt="GNOME Extension" />
  </a>
  <img src="https://img.shields.io/badge/GNOME_Shell-45--50-4A86CF?style=for-the-badge&logo=gnome&logoColor=white" alt="GNOME Shell 45–50" />
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge" alt="License" />
</p>

<h1 align="center">🌐 Internet Speed Meter</h1>

<p align="center">
  <strong>A professional, high-performance network speed monitor and statistics tracker for the GNOME Shell top panel.</strong>
  <br />
  Authored in TypeScript with a focus on zero-impact resource usage and deep system integration.
  <br />
  <br />
  <a href="https://extensions.gnome.org/extension/9828/internet-speed-meter/">Install Now</a>
  ·
  <a href="https://github.com/foss-desk/internet-speed-meter/issues">Report Bug</a>
  ·
  <a href="https://github.com/foss-desk/internet-speed-meter/issues">Request Feature</a>
</p>

---

## ✨ Features

- **🚀 Real-Time Monitoring** — Live download (↓) and upload (↑) speeds seamlessly integrated in the top panel.
- **⚡ Integrated Speedtest Suite** — Run Ping, Jitter, Download, and Upload bandwidth checks instantly without opening a browser through a dedicated Ookla-inspired popup panel.
- **📈 Dual-Mode Graph Analytics** — Interactive menu dashboard featuring both a **Live 60-second Bezier wave graph** and a **Monthly daily history bar chart**.
- **🔋 Smart Battery & VPN Inspector** — Adaptive polling auto-throttles to save battery, alongside real-time recognition for VPNs/Mesh networks (Tailscale, WireGuard, WARP, ZeroTier).
- **📊 App-Level Profiling & Quotas** — Tracks background bandwidth consumption by application and allows setting Monthly Data Caps (GB) with desktop notification alerts.
- **⚙️ Native Preferences** — Full configuration window (Libadwaita) to target interfaces, toggle bits/bytes, tweak visual aesthetics, and export statistical data to CSV logs. 
- **⚡ Deeply Optimized** — Asynchronous I/O, bounds-checking suspend/resume guards, and pure GNOME `St.Icon` symbolic assets ensure ~0% CPU, no GC churn, and native desktop integration.
- **💾 Persistent History** — Automatically tracks and securely caches daily/monthly statistics to `~/.cache/internet-speed-meter/stats.json`.
- **🖥️ GNOME 50+ Ready** — Pure ESM architecture fully compatible with GNOME 45 through 50+.

## 📦 Requirements

| Dependency | Version | Notes |
|------------|---------|-------|
| GNOME Shell | 45 – 50 | Ubuntu, Fedora, Arch, Debian, openSUSE, etc. |
| Node.js | 18+ | Build-time only (npm install) |
| libglib2.0-dev | System | Provides `glib-compile-schemas` |

## 📥 Installation

### 🌍 GNOME Extensions (Recommended)
The easiest way to install and stay updated is through the official GNOME Extensions website.

<a href="https://extensions.gnome.org/extension/9828/internet-speed-meter/">
  <img src="https://img.shields.io/badge/Install_on-GNOME_Extensions-4A86CF?style=for-the-badge&logo=gnome&logoColor=white" alt="Install from GNOME Extensions" />
</a>

---

### 🛠️ Install from Source

```bash
# Clone the repository
git clone https://github.com/foss-desk/internet-speed-meter.git
cd internet-speed-meter

# Build and install
make install

# Enable the extension
gnome-extensions enable speed-meter@mojahid.lunecode.com
```

> **Note:** On Wayland (default on most distros), you must **Log Out and Log Back In** for the extension and its settings button to appear for the first time.

## 🏗️ Project Structure

```
internet-speed-meter/
├── src/
│   ├── extension.ts          # Panel indicator logic
│   ├── prefs.ts              # Settings UI (Libadwaita)
│   ├── stats.ts              # Traffic persistence engine
│   ├── stylesheet.css         # Panel styling
│   ├── metadata.json          # Extension manifest
│   └── schemas/              # GSettings configuration
├── Makefile                   # Build & deployment automation
├── LICENSE                    # GNU GPL v3.0
├── CHANGELOG.md               # Version history
└── CONTRIBUTING.md            # Community guidelines
```

1. **Smart Reading** — Uses `load_contents_async` to fetch data without blocking the UI thread.
2. **Object Reuse** — Uses static `TextDecoder` and `TextEncoder` to prevent Memory/GC churn.
3. **Change Guard** — Only requests a UI redraw if the speed text has actually changed.
4. **Stats Logic** — Calculates deltas between ticks and pushes them to a local cache for daily/monthly tracking.

## 🛠️ Build Commands

| Command | Description |
|---------|-------------|
| `make install` | Build, compile schemas, and install to GNOME |
| `make pack` | Generate `.zip` for extensions.gnome.org |
| `make test` | Launch a nested Wayland shell for safe testing |
| `make logs` | Stream GNOME Shell logs filtered for this extension |

## 📄 License

Licensed under the **GNU General Public License v3.0 or later**.
---

<p align="center">
  Made by <a href="https://github.com/foss-desk">foss-desk</a> for the Linux community.
</p>

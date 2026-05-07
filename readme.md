# Raleys Auto Clipper

Automates the process of logging into a Raley's online grocery account and clipping digital offers using a headless browser and authenticated API requests.

## 🧩 Features

- Cookie-first auth for headless automation, with optional visible login assist
- Retrieves and clips **Something Extra**, **Weekly Exclusive**, and **Digital Coupon** offers
- Optional randomized delays for mimicry and anti-bot evasion
- Supports CLI arguments and `.env` config
- Fully scriptable for cronjobs or automation tools


## ⚙️ Requirements

- Node.js **v18+**
- A Raley's online account with digital offers
- Headless-capable Linux/Windows/macOS (Puppeteer dependencies must be available)


## 📦 Installation

```bash
git clone https://github.com/dj13423/raleys-auto-clipper.git
cd raleys-auto-clipper
npm install
```


## 🛠️ Configuration

### 1. **Using `.env` file** (recommended for automation)

Create a `.env` file in the root directory:
```ini
RALEYS_EMAIL=your-email@example.com
RALEYS_PASSWORD=your-password
MIN_START_DELAY=0
MAX_START_DELAY=0
MIN_REQUEST_DELAY=1000
MAX_REQUEST_DELAY=5000
```

### 2. **Or via CLI arguments**

```bash
node index.js \
  --email your-email@example.com \
  --password your-password \
  --headless \
  --minStartDelay 0 \
  --maxStartDelay 0 \
  --minRequestDelay 1000 \
  --maxRequestDelay 5000
```

---

Run the script with `--help` to see available options and descriptions:

```bash
node index.js --help
```

## ⏱️ Delay Parameters Explained

- `--minStartDelay` and `--maxStartDelay` (milliseconds):  
  Define a randomized delay interval before the script starts executing. This helps avoid detection by varying the start time on each run.  
  **Default:** 0 ms (no delay)

- `--minRequestDelay` and `--maxRequestDelay` (milliseconds):  
  Define a randomized delay interval between individual offer clipping requests. This throttles requests to mimic human behavior and reduce the chance of being flagged.  
  **Default:** 1000 ms (1 second) minimum, 5000 ms (5 seconds) maximum



## 🧪 Behavior

- Logs into [raleys.com](https://raleys.com) using stealth Puppeteer.
- Uses cookies for authenticated API clipping, and can refresh them via visible browser login when needed.
- Randomized script start and request delays can help avoid detection.


## 📚 Notes

- Does not store or cache credentials; ensure `.env` is secure.
- Script assumes a working UI flow and may break if Raley's changes their DOM or login method.
- If offers aren't clipping, inspect the DOM in a non-headless mode or add debug logs.

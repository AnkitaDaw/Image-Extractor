# 🖼 ImageRip — Web Image Extractor

A full-stack tool that extracts every image from any website using Puppeteer.
Built with Node.js, Express, Puppeteer, Cheerio, Bootstrap 5, and JSZip.

---

## Features

- **Full-page scan** — auto-scrolls to trigger lazy-loaded images
- **Multi-source detection** — `<img>`, `<picture>`, `srcset`, CSS `background-image`, inline styles, `data-src` / `data-original` / `data-lazy`
- **Highest-resolution srcset** — always picks the largest image from responsive sets
- **Deduplication** — by URL and by file content hash (MD5)
- **Category folders** — hero / backgrounds / products / icons / others
- **Single download** or **Download All as ZIP**
- **Dark modern dashboard** with image preview, metadata, and lightbox
- **Progress tracking** — real-time polling with progress bar

---

## Project Structure

```
image-extractor/
├── server.js          # Express + Puppeteer backend
├── package.json
├── public/
│   └── index.html     # Frontend dashboard
└── output/            # Created automatically; each job gets a UUID folder
    └── <jobId>/
        ├── hero/
        ├── backgrounds/
        ├── products/
        ├── icons/
        └── others/
```

---

## Setup & Run

### 1. Prerequisites

- **Node.js** v18+ ([nodejs.org](https://nodejs.org))

### 2. Install dependencies

```bash
cd image-extractor
npm install
```

> Puppeteer will automatically download a compatible Chromium binary (~170 MB).

### 3. Start the server

```bash
npm start
```

Or, for development with auto-restart:

```bash
npm run dev
```

### 4. Open the tool

Visit **http://localhost:3000** in your browser.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/extract-images` | Start an extraction job. Body: `{ "url": "https://..." }` |
| `GET`  | `/job-status/:jobId` | Poll job progress and results |
| `GET`  | `/download/:jobId/:category/:filename` | Download a single image |
| `GET`  | `/download-zip/:jobId` | Download all images as ZIP |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Puppeteer fails to launch | Make sure you're on a 64-bit OS. On Linux servers, install: `apt-get install -y libx11-xcb1 libxcomposite1 libxdamage1 libxi6 libxext6 libxtst6 libnss3 libcups2 libxss1 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0` |
| Website blocks the tool | Some sites block headless browsers. Try adding a custom User-Agent or use a residential proxy. |
| No images found | The site may use aggressive anti-bot measures. |
| Output folder grows large | Manually delete old job folders inside `/output/` |

---

## Notes

- This tool is intended for **local / personal use** and respects robots.txt by not crawling multiple pages.
- Always respect website terms of service before extracting images.
- Images remain in the `/output` folder until you delete them.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

// Multer: store uploads in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// Ensure output directory exists
if (!fs.existsSync('./output')) fs.mkdirSync('./output', { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9.\-_]/gi, '-').toLowerCase().slice(0, 100);
}

function getExtFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'image/avif': 'avif', 'image/bmp': 'bmp', 'image/tiff': 'tiff'
  };
  return map[mime?.split(';')[0].trim()] || 'jpg';
}

function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).slice(1).toLowerCase();
    const valid = ['jpg','jpeg','png','webp','gif','svg','avif','bmp','tiff'];
    return valid.includes(ext) ? ext : null;
  } catch { return null; }
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return null; }
}

function pickHighestSrcset(srcset) {
  if (!srcset) return null;
  const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
  let best = null, bestW = 0;
  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;
    const w = parseInt(desc) || 0;
    if (w > bestW) { bestW = w; best = url; }
  }
  return best || parts[0]?.split(/\s+/)[0] || null;
}

function categorizeImage(url, index) {
  const u = url.toLowerCase();
  if (u.includes('hero') || u.includes('banner') || u.includes('header') || u.includes('cover')) return 'hero';
  if (u.includes('bg') || u.includes('background')) return 'backgrounds';
  if (u.includes('product') || u.includes('item') || u.includes('shop')) return 'products';
  if (u.includes('icon') || u.includes('logo') || u.includes('favicon') || u.includes('sprite')) return 'icons';
  return 'others';
}

function fileHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ─── Image extraction via Puppeteer + Cheerio ───────────────────────────────

async function extractImages(targetUrl, jobDir, onProgress) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--no-first-run', '--no-zygote']
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    onProgress('Navigating to page...', 5);

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    onProgress('Auto-scrolling to load lazy images...', 20);

    // Auto-scroll to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    });

    await new Promise(r => setTimeout(r, 2000));

    onProgress('Scanning DOM for image sources...', 35);

    // Collect all image URLs from the page
    const rawUrls = await page.evaluate((base) => {
      const urls = new Set();

      // <img> tags
      document.querySelectorAll('img').forEach(img => {
        ['src','data-src','data-original','data-lazy','data-bg','data-image','data-url'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (v && v.startsWith('http')) urls.add(v);
          else if (v) { try { urls.add(new URL(v, base).href); } catch {} }
        });
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          srcset.split(',').forEach(s => {
            const u = s.trim().split(/\s+/)[0];
            if (u) { try { urls.add(new URL(u, base).href); } catch {} }
          });
        }
      });

      // <picture><source>
      document.querySelectorAll('picture source').forEach(src => {
        const srcset = src.getAttribute('srcset') || src.getAttribute('data-srcset');
        if (srcset) {
          srcset.split(',').forEach(s => {
            const u = s.trim().split(/\s+/)[0];
            if (u) { try { urls.add(new URL(u, base).href); } catch {} }
          });
        }
      });

      // CSS background-image (inline styles)
      document.querySelectorAll('[style]').forEach(el => {
        const m = el.getAttribute('style').match(/url\(['"]?([^'")\s]+)['"]?\)/g);
        if (m) m.forEach(match => {
          const u = match.replace(/url\(['"]?/, '').replace(/['"]?\)/, '');
          if (u && !u.startsWith('data:')) { try { urls.add(new URL(u, base).href); } catch {} }
        });
      });

      // Computed styles for background images
      document.querySelectorAll('div,section,header,footer,aside,article,span').forEach(el => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          const m = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
          if (m && m[1] && !m[1].startsWith('data:')) {
            try { urls.add(new URL(m[1], base).href); } catch {}
          }
        }
      });

      return [...urls];
    }, targetUrl);

    onProgress(`Found ${rawUrls.length} potential image URLs. Downloading...`, 50);

    // Download images
    const seen = new Set();         // dedup by URL
    const hashSeen = new Set();     // dedup by content
    const results = [];
    const counters = {};

    const subDirs = ['hero','backgrounds','products','icons','others'];
    subDirs.forEach(d => fs.mkdirSync(path.join(jobDir, d), { recursive: true }));

    let i = 0;
    for (const imgUrl of rawUrls) {
      if (seen.has(imgUrl)) continue;
      seen.add(imgUrl);

      try {
        const resp = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'Referer': targetUrl,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
          },
          maxContentLength: 50 * 1024 * 1024
        });

        const buffer = Buffer.from(resp.data);
        const hash = fileHash(buffer);
        if (hashSeen.has(hash)) continue;
        hashSeen.add(hash);

        const contentType = resp.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) continue;

        const ext = getExtFromUrl(imgUrl) || getExtFromMime(contentType);
        const category = categorizeImage(imgUrl, i);
        const key = category;
        counters[key] = (counters[key] || 0) + 1;

        const baseName = `${category}-image-${counters[key]}.${ext}`;
        const filePath = path.join(jobDir, category, baseName);
        fs.writeFileSync(filePath, buffer);

        results.push({
          id: uuidv4(),
          filename: baseName,
          category,
          ext,
          size: buffer.length,
          url: imgUrl,
          localPath: `${category}/${baseName}`,
          contentType
        });

        i++;
        const pct = 50 + Math.round((i / rawUrls.length) * 40);
        onProgress(`Downloaded ${i} images...`, Math.min(pct, 88));
      } catch (e) {
        // skip broken URLs silently
      }
    }

    onProgress('Finalizing...', 95);
    return results;

  } finally {
    await browser.close();
  }
}

// ─── Job store (in-memory) ───────────────────────────────────────────────────

const jobs = {};

// ─── Routes ─────────────────────────────────────────────────────────────────

// POST /extract-images
app.post('/extract-images', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Please include http:// or https://' });
  }

  const jobId = uuidv4();
  const jobDir = path.join(__dirname, 'output', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = { status: 'running', progress: 0, message: 'Starting...', images: [], error: null };

  // Run async
  (async () => {
    try {
      const images = await extractImages(url, jobDir, (msg, pct) => {
        jobs[jobId].message = msg;
        jobs[jobId].progress = pct;
      });
      jobs[jobId].status = 'done';
      jobs[jobId].progress = 100;
      jobs[jobId].message = `Extracted ${images.length} images`;
      jobs[jobId].images = images;
      jobs[jobId].jobId = jobId;
    } catch (e) {
      jobs[jobId].status = 'error';
      jobs[jobId].error = e.message || 'Extraction failed';
    }
  })();

  res.json({ jobId });
});

// GET /job-status/:jobId
app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /download/:jobId/:category/:filename
app.get('/download/:jobId/:category/:filename', (req, res) => {
  const { jobId, category, filename } = req.params;
  const filePath = path.join(__dirname, 'output', jobId, category, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, filename);
});

// GET /download-zip/:jobId
app.get('/download-zip/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const jobDir = path.join(__dirname, 'output', jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="images-${jobId.slice(0,8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send(err.message));
  archive.pipe(res);
  archive.directory(jobDir, false);
  archive.finalize();
});

// ─── Screenshot Image Extraction (no AI) ────────────────────────────────────
//
// Strategy:
//  1. Convert uploaded screenshot to raw RGBA pixels via sharp.
//  2. Build a horizontal & vertical "edge density" map by comparing adjacent
//     pixel rows/columns (large luminance jumps → likely image boundaries).
//  3. Find contiguous rectangular candidate regions that look like embedded
//     images: they have smooth interiors (low edge density inside) and crisp
//     edges on all four sides.
//  4. Reject regions that are too small, too thin, or overlap heavily with a
//     larger accepted region.
//  5. Crop each region out of the original screenshot and save as PNG.

async function extractImagesFromScreenshot(imageBuffer, jobDir, onProgress) {
  // ── How it works ───────────────────────────────────────────────────────────
  // Real images/illustrations in screenshots are COLORFUL (high saturation)
  // while UI chrome (backgrounds, cards, text) is near-white, grey, or black.
  //
  // Steps:
  //  1. Convert to HSV; mark pixels as "colorful" (sat>0.20, not near-white/dark)
  //     + include warm-orange pixels (illustration backgrounds like the toy box)
  //  2. Downsample to 6×6 blocks; blocks with ≥6% colorful pixels → "hot"
  //  3. Connected-component label the hot-block grid → one blob per illustration
  //  4. Filter blobs by minimum size and aspect ratio
  //  5. Expand each tight colorful bbox outward until hitting uniform background rows/cols
  //  6. Add padding, crop, save

  onProgress('Decoding pixels…', 10);

  // Decode to raw RGB (no alpha needed)
  const { data: raw, info } = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width, H = info.height;

  onProgress('Finding colorful regions…', 25);

  // ── 1. Colorful pixel mask ─────────────────────────────────────────────────
  const isColorful = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const ri = raw[i * 3] / 255;
    const gi = raw[i * 3 + 1] / 255;
    const bi = raw[i * 3 + 2] / 255;
    const cmax = Math.max(ri, gi, bi);
    const cmin = Math.min(ri, gi, bi);
    const delta = cmax - cmin;
    const sat = cmax > 0.01 ? delta / cmax : 0;
    const val = cmax;
    // Colorful: saturated + visible + not washed out
    const colorful = sat > 0.20 && val > 0.25 && val < 0.97;
    // Warm orange (illustration backgrounds, cardboard, etc.)
    const warmOrange = ri > 0.60 && ri > gi * 1.3 && gi > bi * 1.2 && val > 0.5;
    isColorful[i] = (colorful || warmOrange) ? 1 : 0;
  }

  // ── 2. Downsample to blocks ────────────────────────────────────────────────
  const BLOCK = 6;
  const HOT_FRAC = 0.06;
  const BH = Math.floor(H / BLOCK);
  const BW = Math.floor(W / BLOCK);
  const hot = new Uint8Array(BH * BW);

  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      let cnt = 0;
      for (let dy = 0; dy < BLOCK; dy++) {
        for (let dx = 0; dx < BLOCK; dx++) {
          cnt += isColorful[(by * BLOCK + dy) * W + (bx * BLOCK + dx)];
        }
      }
      hot[by * BW + bx] = cnt / (BLOCK * BLOCK) >= HOT_FRAC ? 1 : 0;
    }
  }

  onProgress('Grouping blobs…', 40);

  // ── 3. Connected components (union-find) ───────────────────────────────────
  const label = new Int32Array(BH * BW).fill(-1);
  const parent = [];

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  let nextLabel = 0;
  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      if (!hot[by * BW + bx]) continue;
      const above = by > 0 ? label[(by - 1) * BW + bx] : -1;
      const left  = bx > 0 ? label[by * BW + bx - 1]  : -1;
      if (above < 0 && left < 0) {
        label[by * BW + bx] = nextLabel; parent.push(nextLabel); nextLabel++;
      } else if (above >= 0 && left < 0) {
        label[by * BW + bx] = above;
      } else if (above < 0 && left >= 0) {
        label[by * BW + bx] = left;
      } else {
        union(above, left);
        label[by * BW + bx] = find(above);
      }
    }
  }
  for (let i = 0; i < BH * BW; i++) {
    if (label[i] >= 0) label[i] = find(label[i]);
  }

  // ── 4. Bounding boxes + filter ─────────────────────────────────────────────
  const bboxMap = {};
  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      const l = label[by * BW + bx];
      if (l < 0) continue;
      const root = find(l);
      if (!bboxMap[root]) bboxMap[root] = { minX: bx, maxX: bx, minY: by, maxY: by, count: 0 };
      const bb = bboxMap[root];
      if (bx < bb.minX) bb.minX = bx;
      if (bx > bb.maxX) bb.maxX = bx;
      if (by < bb.minY) bb.minY = by;
      if (by > bb.maxY) bb.maxY = by;
      bb.count++;
    }
  }

  const MIN_PX  = Math.max(50, Math.min(W, H) * 0.03);
  const MAX_ASP = 7;

  let candidates = Object.values(bboxMap)
    .map(bb => {
      const l = bb.minX * BLOCK, t = bb.minY * BLOCK;
      const r = Math.min(W, (bb.maxX + 1) * BLOCK);
      const b = Math.min(H, (bb.maxY + 1) * BLOCK);
      const rw = r - l, rh = b - t;
      const bbBlocks = (bb.maxX - bb.minX + 1) * (bb.maxY - bb.minY + 1);
      const density = bb.count / bbBlocks;
      if (rw < MIN_PX || rh < MIN_PX) return null;
      if (Math.max(rw / rh, rh / rw) > MAX_ASP) return null;
      if (density < 0.20) return null;  // too sparse (scattered dots)
      return { l, t, r, b, rw, rh };
    })
    .filter(Boolean);

  onProgress('Expanding to full illustrations…', 60);

  // ── 5. Expand each bbox to include full illustration ──────────────────────
  // Walk outward from tight colorful bbox until rows/cols become uniform bg

  function rowIsBackground(rowStart, rowLen, isHoriz, bgThresh = 12) {
    // isHoriz=true: iterate over x; false: iterate over y
    let sumR = 0, sumG = 0, sumB = 0;
    let sumR2 = 0, sumG2 = 0, sumB2 = 0;
    for (let i = 0; i < rowLen; i++) {
      const idx = isHoriz ? rowStart + i : rowStart + i * W;
      const r = raw[idx * 3], g = raw[idx * 3 + 1], b = raw[idx * 3 + 2];
      sumR += r; sumG += g; sumB += b;
      sumR2 += r*r; sumG2 += g*g; sumB2 += b*b;
    }
    const n = rowLen;
    const varR = sumR2/n - (sumR/n)**2;
    const varG = sumG2/n - (sumG/n)**2;
    const varB = sumB2/n - (sumB/n)**2;
    const meanStd = Math.sqrt((varR + varG + varB) / 3);
    const meanBright = (sumR + sumG + sumB) / (3 * n);
    return meanStd < bgThresh && meanBright > 200;
  }

  const PAD = 18;

  candidates = candidates.map(c => {
    let { l, t, r, b } = c;

    // Expand top
    while (t > 0 && !rowIsBackground(t * W + l, r - l, true)) t--;
    // Expand bottom
    while (b < H && !rowIsBackground(b * W + l, r - l, true)) b++;
    // Expand left
    while (l > 0 && !rowIsBackground(t * W + l, b - t, false)) l--;
    // Expand right
    while (r < W && !rowIsBackground(t * W + r, b - t, false)) r++;

    // Add padding
    l = Math.max(0, l - PAD);
    t = Math.max(0, t - PAD);
    r = Math.min(W, r + PAD);
    b = Math.min(H, b + PAD);

    return { l, t, rw: r - l, rh: b - t };
  });

  // Remove duplicates / fully-contained rects
  candidates = candidates.filter((c, i) =>
    !candidates.some((o, j) => j !== i &&
      o.l <= c.l && o.t <= c.t &&
      o.l + o.rw >= c.l + c.rw &&
      o.t + o.rh >= c.t + c.rh &&
      o.rw * o.rh > c.rw * c.rh)
  );

  // Sort largest first
  candidates.sort((a, b) => b.rw * b.rh - a.rw * a.rh);

  onProgress('Cropping and saving…', 80);

  // ── 6. Crop and save ──────────────────────────────────────────────────────
  const results = [];
  fs.mkdirSync(path.join(jobDir, 'regions'), { recursive: true });

  for (let idx = 0; idx < candidates.length; idx++) {
    const { l, t, rw, rh } = candidates[idx];
    const filename = `image-${idx + 1}.png`;
    const filePath = path.join(jobDir, 'regions', filename);

    const cropBuf = await sharp(imageBuffer)
      .extract({ left: l, top: t, width: rw, height: rh })
      .png()
      .toBuffer();

    fs.writeFileSync(filePath, cropBuf);
    results.push({
      id: uuidv4(),
      filename,
      category: 'regions',
      ext: 'png',
      size: cropBuf.length,
      url: `Extracted image ${idx + 1} — ${rw}×${rh} px`,
      localPath: `regions/${filename}`,
      contentType: 'image/png',
    });
  }

  return results;
}

// POST /extract-screenshot  (multipart: field "screenshot")
app.post('/extract-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });

  const jobId  = uuidv4();
  const jobDir = path.join(__dirname, 'output', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = { status: 'running', progress: 0, message: 'Analysing screenshot...', images: [], error: null };

  (async () => {
    try {
      const images = await extractImagesFromScreenshot(req.file.buffer, jobDir, (msg, pct) => {
        jobs[jobId].message  = msg;
        jobs[jobId].progress = pct;
      });

      jobs[jobId].message  = `Extracted ${images.length} image region(s)`;
      jobs[jobId].progress = 100;
      jobs[jobId].status   = 'done';
      jobs[jobId].images   = images;
      jobs[jobId].jobId    = jobId;
    } catch (e) {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = e.message || 'Extraction failed';
    }
  })();

  res.json({ jobId });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Image Extractor running at http://localhost:${PORT}\n`);
});

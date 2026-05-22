const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Use PUPPETEER_CACHE_DIR env var if set (Render sets this via render.yaml),
  // otherwise fall back to a local .cache/puppeteer directory.
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(__dirname, '.cache', 'puppeteer'),
};

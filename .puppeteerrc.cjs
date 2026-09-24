const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Garantiza que la carpeta del navegador viva dentro del build de Render
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Asegura que Chromium se descargue dentro de la carpeta del proyecto
  cacheDirectory: join(__dirname, '.puppeteer-cache'),
};
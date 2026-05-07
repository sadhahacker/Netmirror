const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { setupProxy } = require('./lib/proxy');

const PORT = process.env.PORT || 7000;
process.env.SERVER_URL = process.env.SERVER_URL || `http://127.0.0.1:${PORT}`;

const addonInterface = require('./addon');

const app = express();

// Mount the Stremio addon routes
app.use(getRouter(addonInterface));

// Mount our HLS proxy
setupProxy(app);

const server = app.listen(PORT, () => {
  console.log(`\nNetMirror Stremio Addon running at ${process.env.SERVER_URL}`);
  console.log(`Add to Stremio: ${process.env.SERVER_URL}/manifest.json\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nERROR: Port ${PORT} is already in use. Run: kill $(lsof -t -i:${PORT})\n`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});

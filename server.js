/**
 * server.js — Minimal HTTP health-check server for Render / container platforms.
 *
 * Render web services must bind to $PORT and respond to HTTP probes. This tiny
 * server exposes / (health) and /status (last run summary) while the capture
 * loop runs in the background. No external dependencies.
 */
const http = require('http');

let state = {
  startedAt: Date.now(),
  lastRunAt: null,
  lastRunOk: null,
  lastRunError: null,
  lastSummary: null,
  runs: 0,
};

function setState(patch) { Object.assign(state, patch); }
function getState() { return { ...state, uptime: Date.now() - state.startedAt }; }

function start(port) {
  port = port || Number(process.env.PORT) || 10000;
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getState(), null, 2));
      return;
    }
    res.setHeader('Content-Type', 'text/plain');
    res.end('virtual-football prediction bot: OK\n');
  });
  server.listen(port, () => {
    console.log(`[server] health check listening on :${port}`);
  });
  return server;
}

module.exports = { start, setState, getState };

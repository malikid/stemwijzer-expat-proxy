/**
 * Stemwijzer local proxy
 * Serves the wrapper page and proxies the embed script + iframe
 * with Referer: https://www.parool.nl/ so the app accepts the embed.
 *
 * Usage:
 *   node server.js
 * Then open: http://localhost:3000
 */

const http = require("http");
const https = require("https");
const url = require("url");
const path = require("path");
const fs = require("fs");

const PORT = 3000;
const SPOOF_REFERER = "https://www.parool.nl/";
const UPSTREAM_HOST = "gr2026.stemwijzer.nl";

// ── Wrapper HTML served at / ──────────────────────────────────────────────────
const WRAPPER_HTML = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- Tell the browser to send the full URL as Referer for all sub-resources -->
  <meta name="referrer" content="unsafe-url" />
  <title>Stemwijzer GR2026</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: sans-serif;
      background: #f4f4f4;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    #tip {
      width: 100%;
      max-width: 860px;
      background: #1a73e8;
      color: #fff;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      font-size: 14px;
      line-height: 1.6;
    }
    #tip strong { display: block; font-size: 15px; margin-bottom: 4px; }
    #votematch-container {
      width: 100%;
      max-width: 860px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,.12);
      overflow: hidden;
    }
    #votematch-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid #e0e0e0;
    }
    .votematch-controls-left, .votematch-controls-right {
      display: flex; align-items: center; gap: 8px;
    }
    button, a.btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: none; border: 1px solid #ccc; border-radius: 4px;
      padding: 6px 10px; font-size: 13px; cursor: pointer;
      text-decoration: none; color: inherit;
    }
    button img, a.btn img { width: 16px; height: 16px; }
    #votematch-embed {
      width: 100%; border: none; display: block;
      min-height: 600px; height: 1161px;
    }
  </style>
</head>
<body>
  <div id="tip">
    <strong>💡 Tip for expats</strong>
    Right-click anywhere → <em>Translate to English</em> (or your language).
    Chrome will translate the entire questionnaire automatically.
  </div>

  <div id="votematch-container">
    <div id="votematch-controls">
      <div class="votematch-controls-left">
        <button>ℹ️ Vote Compass &amp; media partners</button>
        <a class="btn" href="https://stemwijzer.nl/privacy/" target="_blank" rel="noopener">
          🔒 Privacy ↗
        </a>
      </div>
      <div class="votematch-controls-right">
        <button onclick="toggleFS()">⛶ Enlarge</button>
      </div>
    </div>

    <!--
      The iframe src points to our LOCAL proxy (/proxy/...) so the browser
      sends Referer: http://localhost:3000 — but our proxy rewrites that
      to Referer: https://www.parool.nl/ before forwarding upstream.
    -->
    <iframe
      src="/proxy/app/index.html#/GM0363-nl/start"
      loading="lazy"
      scrolling="no"
      allowfullscreen=""
      id="votematch-embed">
    </iframe>
  </div>

  <!-- Embed script also served through our proxy so headers are correct -->
  <script
    src="/proxy/embed/embed.js?v=1.0.0&select=gm0363-nl&canselect=true"
    defer async>
  </script>

  <script>
    function toggleFS() {
      const el = document.getElementById("votematch-container");
      if (!document.fullscreenElement) el.requestFullscreen();
      else document.exitFullscreen();
    }
  </script>
</body>
</html>`;

// ── Proxy helper ──────────────────────────────────────────────────────────────
function proxyRequest(req, res, upstreamPath) {
  const options = {
    hostname: UPSTREAM_HOST,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: {
      // Forward useful headers but override the ones that matter
      "accept":          req.headers["accept"]          || "*/*",
      "accept-encoding": req.headers["accept-encoding"] || "identity",
      "accept-language": req.headers["accept-language"] || "nl,en;q=0.9",
      "user-agent":      req.headers["user-agent"]      || "Mozilla/5.0",
      // ← The magic: lie about where we're coming from
      "referer":         SPOOF_REFERER,
      "origin":          "https://www.parool.nl",
      "host":            UPSTREAM_HOST,
    },
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    // Strip headers that would break things in a proxied context
    const headers = { ...upstreamRes.headers };
    delete headers["content-security-policy"];
    delete headers["x-frame-options"];
    // Allow our local page to load the response
    headers["access-control-allow-origin"] = "*";

    res.writeHead(upstreamRes.statusCode, headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (err) => {
    console.error("Upstream error:", err.message);
    res.writeHead(502);
    res.end("Bad gateway: " + err.message);
  });

  req.pipe(upstreamReq);
}

// ── Main server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  console.log(`${req.method} ${req.url}`);

  // Serve wrapper page
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WRAPPER_HTML);
    return;
  }

  // Proxy everything under /proxy/* to the upstream host
  if (pathname.startsWith("/proxy/")) {
    // Strip the /proxy prefix to get the real upstream path
    const upstreamPath = pathname.slice("/proxy".length) +
                         (parsed.search || "");
    proxyRequest(req, res, upstreamPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n✅  Stemwijzer proxy running at http://localhost:${PORT}`);
  console.log(`   Open that URL in Chrome and use Translate Page as normal.\n`);
});

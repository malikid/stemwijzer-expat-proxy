/**
 * Stemwijzer local proxy
 * Serves the wrapper page and proxies all assets/data for the embed.
 *
 * Referer strategy:
 *   - embed.js and the iframe entry point  → Referer: https://www.parool.nl/
 *   - everything else (assets, API calls)  → no Referer header at all
 *     (mimics what a browser does when you paste a URL directly into the bar)
 *
 * Also rewrites absolute URLs inside proxied HTML/JS/CSS responses so that
 * secondary fetches also go through this proxy.
 *
 * Usage:
 *   node server.js
 * Then open: http://localhost:3000
 */

const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");

const PORT = 3000;
const SPOOF_REFERER = "https://www.parool.nl/";
const UPSTREAM_HOST = "gr2026.stemwijzer.nl";
const UPSTREAM_ORIGIN = "https://" + UPSTREAM_HOST;
const LOCAL_ORIGIN   = "http://localhost:" + PORT;

// Paths that need the parool.nl referer to pass the embed check
const NEEDS_PAROOL_REFERER = [
  /^\/embed\/embed\.js/,
  /^\/app\/index\.html/,
];

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

// ── Rewrite URLs in text responses so secondary fetches go through the proxy ──
function rewriteBody(body, contentType) {
  if (!/text|javascript|json/.test(contentType || "")) return body;
  // Replace https://gr2026.stemwijzer.nl  →  http://localhost:PORT/proxy
  return body.split(UPSTREAM_ORIGIN).join(LOCAL_ORIGIN + "/proxy");
}

// ── Decompress a buffer based on content-encoding ────────────────────────────
function decompress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip")   return zlib.gunzip(buffer, (e, b) => e ? reject(e) : resolve(b));
    if (encoding === "deflate") return zlib.inflate(buffer, (e, b) => e ? reject(e) : resolve(b));
    if (encoding === "br")     return zlib.brotliDecompress(buffer, (e, b) => e ? reject(e) : resolve(b));
    resolve(buffer); // identity / no encoding
  });
}

// ── Proxy helper ──────────────────────────────────────────────────────────────
function proxyRequest(req, res, upstreamPath) {
  const needsParoolReferer = NEEDS_PAROOL_REFERER.some(re => re.test(upstreamPath));

  const reqHeaders = {
    "accept":          req.headers["accept"]          || "*/*",
    // Ask for uncompressed OR gzip — we handle both; avoids brotli issues
    "accept-encoding": "gzip, deflate, identity",
    "accept-language": req.headers["accept-language"] || "nl,en;q=0.9",
    "user-agent":      req.headers["user-agent"]      || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0",
    "host":            UPSTREAM_HOST,
  };

  if (needsParoolReferer) {
    // Embed entry points: pretend we're parool.nl
    reqHeaders["referer"] = SPOOF_REFERER;
    reqHeaders["origin"]  = "https://www.parool.nl";
    console.log(`  → sending parool referer for ${upstreamPath}`);
  } else {
    // Assets/API: no referer (mimics direct browser navigation — always works)
    console.log(`  → no referer for ${upstreamPath}`);
  }

  const options = {
    hostname: UPSTREAM_HOST,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: reqHeaders,
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    const status      = upstreamRes.statusCode;
    const contentType = upstreamRes.headers["content-type"] || "";
    const encoding    = upstreamRes.headers["content-encoding"] || "";

    // Strip problematic response headers
    const outHeaders = { ...upstreamRes.headers };
    delete outHeaders["content-security-policy"];
    delete outHeaders["x-frame-options"];
    delete outHeaders["content-encoding"]; // we'll re-encode ourselves if needed
    outHeaders["access-control-allow-origin"] = "*";

    console.log(`  ← ${status} ${contentType.split(";")[0]} [${upstreamPath.split("?")[0]}]`);

    // For text/JS/JSON: buffer, decompress, rewrite URLs, re-send
    if (/text|javascript|json/.test(contentType)) {
      const chunks = [];
      upstreamRes.on("data", c => chunks.push(c));
      upstreamRes.on("end", async () => {
        try {
          const raw       = Buffer.concat(chunks);
          const decompressed = await decompress(raw, encoding);
          const rewritten = rewriteBody(decompressed.toString("utf8"), contentType);
          const outBuf    = Buffer.from(rewritten, "utf8");
          outHeaders["content-length"] = String(outBuf.length);
          res.writeHead(status, outHeaders);
          res.end(outBuf);
        } catch (e) {
          console.error("Decompress/rewrite error:", e.message);
          res.writeHead(502);
          res.end("Proxy rewrite error: " + e.message);
        }
      });
    } else {
      // Binary assets (images, fonts, wasm…): stream straight through
      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    }
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
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  // Serve wrapper page
  if (pathname === "/" || pathname === "/index.html") {
    console.log("GET / → wrapper page");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WRAPPER_HTML);
    return;
  }

  // Everything else is a proxied upstream request
  // Support two URL shapes:
  //   /proxy/some/path   (explicit prefix from our HTML)
  //   /some/path         (absolute URLs rewritten inside JS/HTML by rewriteBody)
  let upstreamPath;
  if (pathname.startsWith("/proxy/")) {
    upstreamPath = pathname.slice("/proxy".length) + (parsed.search || "");
  } else {
    // Treat as a direct upstream path (rewritten URLs inside JS won't have /proxy prefix)
    upstreamPath = pathname + (parsed.search || "");
  }

  console.log(`${req.method} ${upstreamPath}`);
  proxyRequest(req, res, upstreamPath);
});

server.listen(PORT, () => {
  console.log(`\n✅  Stemwijzer proxy running at http://localhost:${PORT}`);
  console.log(`   Open that URL in Chrome and use Translate Page as normal.`);
  console.log(`   Watch this console to see which requests succeed/fail.\n`);
});

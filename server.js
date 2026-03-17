/**
 * Stemwijzer local proxy
 *
 * Routes all *.stemwijzer.nl subdomains through /proxy/<subdomain>/path
 * so the browser never makes direct requests that would leak localhost as referer.
 *
 * Referer strategy:
 *   - embed.js + app/index.html on gr2026  → Referer: https://www.parool.nl/
 *   - everything else                      → no Referer at all
 *     (same as pasting a URL directly into the address bar — always allowed)
 *
 * URL rewriting in responses rewrites ALL https://*.stemwijzer.nl/... URLs
 * to http://localhost:3000/proxy/<subdomain>/... so every subsequent fetch
 * also flows through this proxy.
 *
 * Usage:
 *   node server.js
 * Then open: http://localhost:3000
 */

const http  = require("http");
const https = require("https");
const url   = require("url");
const zlib  = require("zlib");

const PORT = process.env.PORT || 3000;
const SPOOF_REFERER = "https://www.parool.nl/";
const LOCAL_ORIGIN  = "http://localhost:" + PORT;
const STEMWIJZER_RE = /https:\/\/([\w-]+\.stemwijzer\.nl)/g;

// Explicit referer/origin rules. Checked in order; first match wins.
// Anything not matched gets NO referer/origin (safe default for plain assets).
const REFERER_RULES = [
  // Embed entry points must look like they come from parool.nl
  { sub: 'gr2026',      path: /^\/embed\/embed\.js/, referer: 'https://www.parool.nl/',        origin: 'https://www.parool.nl' },
  { sub: 'gr2026',      path: /^\/app\/index\.html/, referer: 'https://www.parool.nl/',        origin: 'https://www.parool.nl' },
  // Data API is fetched from inside the iframe — must look like it comes from the app itself
  { sub: 'gr2026-data', path: /^\//,                   referer: 'https://gr2026.stemwijzer.nl/', origin: 'https://gr2026.stemwijzer.nl' },
];

// ── Wrapper HTML ──────────────────────────────────────────────────────────────
const WRAPPER_HTML = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
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
    #votematch-embed {
      width: 100%; border: none; display: block;
      min-height: 600px; height: 1161px;
    }
  </style>
</head>
<body>
  <div id="tip">
    <strong>💡 Tip for expats</strong>
    Right-click anywhere on this page and choose <em>Translate to English</em>.
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

    <iframe
      src="/proxy/gr2026/app/index.html#/GM0363-nl/start"
      loading="lazy"
      scrolling="no"
      allowfullscreen=""
      id="votematch-embed">
    </iframe>
  </div>

  <script src="/proxy/gr2026/embed/embed.js?v=1.0.0&select=gm0363-nl&canselect=true" defer async></script>

  <script>
    function toggleFS() {
      const el = document.getElementById("votematch-container");
      if (!document.fullscreenElement) el.requestFullscreen();
      else document.exitFullscreen();
    }
  </script>
</body>
</html>`;

// ── Decompress ────────────────────────────────────────────────────────────────
function decompress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip")    return zlib.gunzip(buffer,           (e, b) => e ? reject(e) : resolve(b));
    if (encoding === "deflate") return zlib.inflate(buffer,          (e, b) => e ? reject(e) : resolve(b));
    if (encoding === "br")      return zlib.brotliDecompress(buffer, (e, b) => e ? reject(e) : resolve(b));
    resolve(buffer);
  });
}

// ── URL rewriter ──────────────────────────────────────────────────────────────
// Rewrites every https://<sub>.stemwijzer.nl  →  http://localhost:PORT/proxy/<sub>
// so all downstream fetches (from rewritten JS/HTML) flow through this proxy.
function rewriteBody(text) {
  return text.replace(STEMWIJZER_RE, (_match, host) => {
    const sub = host.replace(".stemwijzer.nl", "");
    return LOCAL_ORIGIN + "/proxy/" + sub;
  });
}

// ── Proxy a single upstream request ──────────────────────────────────────────
function proxyRequest(req, res, subdomain, upstreamPath) {
  const hostname = subdomain + ".stemwijzer.nl";

  const rule = REFERER_RULES.find(r => r.sub === subdomain && r.path.test(upstreamPath));

  const reqHeaders = {
    'accept':          req.headers['accept'] || '*/*',
    'accept-encoding': 'gzip, deflate, identity',
    'accept-language': req.headers['accept-language'] || 'nl,en;q=0.9',
    'user-agent':      req.headers['user-agent'] ||
                       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
    'host':            hostname,
  };

  if (rule) {
    reqHeaders['referer'] = rule.referer;
    reqHeaders['origin']  = rule.origin;
    console.log(`  [rule: ${rule.origin}] ${hostname}${upstreamPath}`);
  } else {
    console.log(`  [no referer]          ${hostname}${upstreamPath}`);
  }

  const options = {
    hostname,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: reqHeaders,
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    const status      = upstreamRes.statusCode;
    const contentType = upstreamRes.headers["content-type"] || "";
    const encoding    = upstreamRes.headers["content-encoding"] || "";

    const outHeaders = { ...upstreamRes.headers };
    delete outHeaders["content-security-policy"];
    delete outHeaders["content-security-policy-report-only"];
    delete outHeaders["x-frame-options"];
    delete outHeaders["content-encoding"]; // we decompress; length changes
    outHeaders["access-control-allow-origin"] = "*";

    console.log(`    <- ${status} [${contentType.split(";")[0]}]`);

    if (/text|javascript|json/.test(contentType)) {
      const chunks = [];
      upstreamRes.on("data", c => chunks.push(c));
      upstreamRes.on("end", async () => {
        try {
          const raw       = Buffer.concat(chunks);
          const plain     = await decompress(raw, encoding);
          const rewritten = rewriteBody(plain.toString("utf8"));
          const outBuf    = Buffer.from(rewritten, "utf8");
          outHeaders["content-length"] = String(outBuf.length);
          res.writeHead(status, outHeaders);
          res.end(outBuf);
        } catch (e) {
          console.error("  rewrite error:", e.message);
          res.writeHead(502);
          res.end("Proxy rewrite error: " + e.message);
        }
      });
    } else {
      // Binary (images, fonts, wasm, etc.) — stream straight through
      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    }
  });

  upstreamReq.on("error", err => {
    console.error("  upstream error:", err.message);
    res.writeHead(502);
    res.end("Bad gateway: " + err.message);
  });

  req.pipe(upstreamReq);
}

// ── Main server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;
  const qs       = parsed.search || "";

  // Root → wrapper page
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WRAPPER_HTML);
    return;
  }

  // /proxy/<subdomain>/path  (any *.stemwijzer.nl subdomain)
  const m = pathname.match(/^\/proxy\/([\w-]+)(\/.*)?$/);
  if (m) {
    const subdomain    = m[1];
    const upstreamPath = (m[2] || "/") + qs;
    proxyRequest(req, res, subdomain, upstreamPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found. Requests must use /proxy/<subdomain>/path");
});

server.listen(PORT, () => {
  console.log(`\n✅  Stemwijzer proxy -> http://localhost:${PORT}`);
  console.log(`   Handles any *.stemwijzer.nl subdomain via /proxy/<sub>/path`);
  console.log(`   Open the URL above in Chrome, then Translate Page.\n`);
});

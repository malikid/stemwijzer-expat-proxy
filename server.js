/**
 * Stemwijzer local proxy
 *
 * Routes all *.stemwijzer.nl subdomains through /proxy/<subdomain>/path
 * so the browser never makes direct requests that would leak localhost as referer.
 *
 * Referer strategy:
 *   - embed.js + app/index.html on gr2026  → Referer: https://www.parool.nl/
 *   - gr2026-data/*                        → Referer: https://gr2026.stemwijzer.nl/
 *   - everything else                      → no Referer at all
 *
 * URL rewriting replaces all https://*.stemwijzer.nl URLs in responses with
 * the public host URL so the browser's subsequent fetches also go through us.
 *
 * Usage (local):
 *   node server.js          → http://localhost:3000
 *
 * Usage (Render):
 *   Render sets RENDER_EXTERNAL_URL automatically — no config needed.
 */

const http  = require("http");
const https = require("https");
const url   = require("url");
const zlib  = require("zlib");

const PORT = process.env.PORT || 3000;

const SPOOF_REFERER = "https://www.parool.nl/";

// On Render, RENDER_EXTERNAL_URL is set automatically to the public URL.
// Locally it falls back to http://localhost:PORT.
// We strip any trailing slash so concatenation is clean.
const PUBLIC_HOST = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.trimEnd().replace(/\/+$/, "")
  : "http://localhost:" + PORT;

const STEMWIJZER_RE = /https:\/\/([\w-]+\.stemwijzer\.nl)/g;

// Referer rules — checked in order, first match wins.
// No match = no Referer header sent (safe default, mimics direct URL paste).
const REFERER_RULES = [
  {
    sub: "gr2026",
    path: /^\/embed\/embed\.js/,
    referer: "https://www.parool.nl/",
    origin: "https://www.parool.nl",
  },
  {
    sub: "gr2026",
    path: /^\/app\/index\.html/,
    referer: "https://www.parool.nl/",
    origin: "https://www.parool.nl",
  },
  {
    sub: "gr2026-data",
    path: /^\//,
    referer: "https://gr2026.stemwijzer.nl/",
    origin: "https://gr2026.stemwijzer.nl",
  },
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

  <div id="votematch-container"></div>

  <script src="/proxy/gr2026/embed/embed.js?v=1.0.0&select=gm0363-nl&canselect=true" defer async></script>
</body>
</html>`;

// ── Decompress ────────────────────────────────────────────────────────────────
function decompress(buffer, encoding) {
  return new Promise(function(resolve, reject) {
    if (encoding === "gzip")    return zlib.gunzip(buffer,           function(e,b){ e ? reject(e) : resolve(b); });
    if (encoding === "deflate") return zlib.inflate(buffer,          function(e,b){ e ? reject(e) : resolve(b); });
    if (encoding === "br")      return zlib.brotliDecompress(buffer, function(e,b){ e ? reject(e) : resolve(b); });
    resolve(buffer);
  });
}

// ── URL rewriter ──────────────────────────────────────────────────────────────
// Replaces every https://<sub>.stemwijzer.nl with PUBLIC_HOST/proxy/<sub>
// so all downstream fetches triggered by rewritten JS/HTML go through this proxy.
function rewriteBody(text) {
  return text.replace(STEMWIJZER_RE, function(_match, host) {
    var sub = host.replace(".stemwijzer.nl", "");
    return PUBLIC_HOST + "/proxy/" + sub;
  });
}

// ── Proxy a single upstream request ──────────────────────────────────────────
function proxyRequest(req, res, subdomain, upstreamPath) {
  var hostname = subdomain + ".stemwijzer.nl";
  var rule = null;
  for (var i = 0; i < REFERER_RULES.length; i++) {
    if (REFERER_RULES[i].sub === subdomain && REFERER_RULES[i].path.test(upstreamPath)) {
      rule = REFERER_RULES[i];
      break;
    }
  }

  var reqHeaders = {
    "accept":          req.headers["accept"] || "*/*",
    "accept-encoding": "gzip, deflate, identity",
    "accept-language": req.headers["accept-language"] || "nl,en;q=0.9",
    "user-agent":      req.headers["user-agent"] ||
                       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0",
    "host":            hostname,
  };

  if (rule) {
    reqHeaders["referer"] = rule.referer;
    reqHeaders["origin"]  = rule.origin;
    console.log("  [rule: " + rule.origin + "] " + hostname + upstreamPath);
  } else {
    console.log("  [no referer]     " + hostname + upstreamPath);
  }

  var options = {
    hostname: hostname,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: reqHeaders,
  };

  var upstreamReq = https.request(options, function(upstreamRes) {
    var status      = upstreamRes.statusCode;
    var contentType = upstreamRes.headers["content-type"] || "";
    var encoding    = upstreamRes.headers["content-encoding"] || "";

    var outHeaders = Object.assign({}, upstreamRes.headers);
    delete outHeaders["content-security-policy"];
    delete outHeaders["content-security-policy-report-only"];
    delete outHeaders["x-frame-options"];
    delete outHeaders["content-encoding"];
    outHeaders["access-control-allow-origin"] = "*";

    console.log("    <- " + status + " [" + contentType.split(";")[0] + "] " + upstreamPath.split("?")[0]);

    if (/text|javascript|json/.test(contentType)) {
      var chunks = [];
      upstreamRes.on("data", function(c) { chunks.push(c); });
      upstreamRes.on("end", function() {
        decompress(Buffer.concat(chunks), encoding).then(function(plain) {
          var rewritten = rewriteBody(plain.toString("utf8"));
          var outBuf    = Buffer.from(rewritten, "utf8");
          outHeaders["content-length"] = String(outBuf.length);
          res.writeHead(status, outHeaders);
          res.end(outBuf);
        }).catch(function(e) {
          console.error("  rewrite error:", e.message);
          res.writeHead(502);
          res.end("Proxy rewrite error: " + e.message);
        });
      });
    } else {
      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    }
  });

  upstreamReq.on("error", function(err) {
    console.error("  upstream error:", err.message);
    res.writeHead(502);
    res.end("Bad gateway: " + err.message);
  });

  req.pipe(upstreamReq);
}

// ── Main server ───────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  var parsed   = url.parse(req.url);
  var pathname = parsed.pathname;
  var qs       = parsed.search || "";

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WRAPPER_HTML);
    return;
  }

  var m = pathname.match(/^\/proxy\/([\w-]+)(\/.*)?$/);
  if (m) {
    var subdomain    = m[1];
    var upstreamPath = (m[2] || "/") + qs;
    proxyRequest(req, res, subdomain, upstreamPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found. Requests must use /proxy/<subdomain>/path");
});

server.listen(PORT, function() {
  console.log("\n✅  Stemwijzer proxy running");
  console.log("   Public host : " + PUBLIC_HOST);
  console.log("   Local port  : " + PORT);
  console.log("   Open the URL above in Chrome, then Translate Page.\n");
});

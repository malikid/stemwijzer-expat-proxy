# Stemwijzer Expat Proxy (GR2026, SR2026)

**Demo:** https://stemwijzer-expat-proxy.onrender.com/

A lightweight Node.js proxy that lets expats in the Netherlands use their browser's built-in **Translate Page** feature on the [Stemwijzer](https://stemwijzer.nl) voting guide questionnaire.

## The problem

The Stemwijzer questionnaire is embedded as an iframe on news sites like parool.nl. Browser translation doesn't work on cross-origin iframes, and the iframe URL itself redirects if accessed directly — it checks that requests come from an allowed referrer.

## How it works

This proxy sits between your browser and `*.stemwijzer.nl`:

- Serves a wrapper page at `/` that your browser can translate normally
- Routes all requests to `*.stemwijzer.nl` through `/proxy/<subdomain>/path`
- Injects the correct `Referer` and `Origin` headers per request so the stemwijzer servers accept them:
  - `embed.js` and `app/index.html` → `Referer: https://www.parool.nl/`
  - `gr2026-data/*` (data API) → `Referer: https://gr2026.stemwijzer.nl/`
  - Everything else (assets, fonts, images) → no `Referer` (mimics direct browser navigation)
- Rewrites all `https://*.stemwijzer.nl` URLs inside JS/HTML/JSON responses so every downstream fetch also flows through the proxy
- Strips `Content-Security-Policy` and `X-Frame-Options` headers that would otherwise block the embed

## Requirements

- [Node.js](https://nodejs.org/) v14 or newer — check with `node --version`
- No npm dependencies — uses only Node built-ins (`http`, `https`, `url`, `zlib`)

## Run locally

```bash
git clone https://github.com/YOUR_USERNAME/stemwijzer-expat-proxy.git
cd stemwijzer-expat-proxy
node server.js
```

Then open **http://localhost:3000** in Chrome.

## Translate the questionnaire

Once the page loads, Chrome should offer to translate automatically (the page is in Dutch). If not:

- Click the **translate icon** (🌐) in the address bar, or
- Right-click anywhere on the page → **Translate to English** (or your language)

Chrome translates the entire page including the questionnaire inside the embed.

## How the referer rules work

The `REFERER_RULES` array in `server.js` controls which `Referer`/`Origin` headers are sent for which requests. Rules are checked in order; the first match wins. If nothing matches, no `Referer` is sent (the safest default — equivalent to pasting a URL directly into the address bar).

To add a rule for a new subdomain or path that returns 403:

```js
{
  sub: "subdomain-name",   // e.g. "gr2026-data"
  path: /^\//,             // regex matched against the request path
  referer: "https://...",  // Referer header value to send
  origin: "https://...",   // Origin header value to send
},
```

## Project structure

```
stemwijzer-expat-proxy/
└── server.js      # everything — proxy logic, referer rules, wrapper HTML
```

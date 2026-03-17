# Stemwijzer Local Proxy

Lets you use Chrome's "Translate page" on the Stemwijzer questionnaire
by spoofing the `Referer` header as `https://www.parool.nl/`.

## Requirements

- [Node.js](https://nodejs.org/) (v14 or newer) — check with `node --version`

## Setup & run

```bash
# 1. Go into this folder
cd stemwijzer-proxy

# 2. Start the server (no dependencies to install!)
node server.js
```

Then open **http://localhost:3000** in Chrome.

## Translate the page

Chrome should offer to translate automatically (the page is in Dutch).
If not: click the 🌐 icon in the address bar, or right-click → Translate to English.

## Share with other expats

Send them this folder. They only need Node.js installed and run `node server.js`.
Or upload `server.js` to any Node.js host (Railway, Render, Glitch, etc.) for a
public shareable link — no npm install needed, it uses only Node built-ins.

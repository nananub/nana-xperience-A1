// XPerience back end: a tiny dependency-free Node server.
// - serves the front end from /public
// - POST /api/chat       -> a friend (Lumi, Bit_Bunny, Mx. Pixel, tide_pool) replies using an AI model
// - POST /api/assistant  -> the Ask-O-Tron 2000 robot replies (knowledge ends Dec 2014)
// - GET  /api/spotify    -> track list of a Spotify playlist / album / track, so the iPod can show it
//                           and skip between songs (needs SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET)
// The API key is read from the environment (.env) and NEVER sent to the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LORE, PERSONAS, ASSISTANT } = require('./personas');

// --- tiny .env loader (so you don't need any npm packages) ---
// .env = your secrets; .env.local = written automatically by "npx convex dev" (the Convex address)
for (const envFile of ['.env.local', '.env']) try {
  for (const line of fs.readFileSync(path.join(__dirname, envFile), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    // the .env file wins over an old Windows/terminal setting with the same name
    if (m[1] in process.env && process.env[m[1]] !== v) console.log(`Note: ${m[1]} was also set outside .env; using the value from .env.`);
    process.env[m[1]] = v;
  }
} catch (e) { /* no .env file */ }

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.MODEL || 'liquid/lfm-3-1.7b:free';
const BASE = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const SP_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SP_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const VERSION = 'online-1';
// the Convex address for XPerience Online (chat between users + forum)
const CONVEX_URL = (process.env.CONVEX_URL || process.env.VITE_CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL ||
  ((process.env.CONVEX_DEPLOYMENT || '').match(/^(?:dev|prod):([a-z0-9-]+)/) ? `https://${RegExp.$1}.convex.cloud` : '')).trim();
const CONVEX_LIB = path.join(__dirname, 'node_modules', 'convex', 'dist', 'browser.bundle.js');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// very small rate limiter: 40 requests per minute per IP
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 40;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, data = '';
    req.on('data', c => { size += c.length; if (size > 30000) { reject(new Error('too big')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

// keep only valid, short messages from the browser
function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-14)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 500) }));
}

// --- AI: try your MODEL first; if a free model is busy or gone, automatically try other free models ---
// FALLBACK_MODELS in .env (comma separated) is optional; otherwise the server picks from OpenRouter's current free list.
const PREFERRED = (process.env.FALLBACK_MODELS || 'liquid/lfm-3-1.7b:free,nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free,baidu/ernie-5.5-flash-preview:free,liquid/lfm-2.5-2.6b:free')
  .split(',').map(x => x.trim()).filter(Boolean);
let freeList = null, freeAt = 0, lastGood = null, dailyLimitUntil = 0, lastTries = [];
async function freeModels() {
  if (freeList && Date.now() - freeAt < 3600000) return freeList;
  try {
    const j = await (await fetch(BASE + '/models', { signal: AbortSignal.timeout(8000) })).json();
    freeList = (j.data || []).filter(m => m.id.endsWith(':free')
      && ((m.architecture && m.architecture.output_modalities) || ['text']).includes('text')
      && !/code|coder|reasoning|guard|embed|inkling/i.test(m.id)).map(m => m.id);
    freeAt = Date.now();
  } catch (e) { freeList = freeList || []; }
  return freeList;
}
async function candidates() {
  const all = await freeModels(), avail = id => !all.length || all.includes(id) || !id.endsWith(':free');
  const list = [lastGood, MODEL, ...PREFERRED.filter(avail), ...all].filter(Boolean);
  return [...new Set(list)].slice(0, 5);
}
async function tryModel(model, system, messages) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Title': 'XPerience.exe' },
    // some free models 'think' before answering; keep that short and hidden so the real answer always fits
    body: JSON.stringify({ model, max_tokens: 1200, temperature: 0.9, reasoning: { effort: 'low', exclude: true }, messages: [{ role: 'system', content: system }, ...messages] }),
    signal: AbortSignal.timeout(20000)
  });
  const raw = await r.text(); let j = null; try { j = JSON.parse(raw); } catch (e) { }
  if (!r.ok) { const e = new Error('upstream ' + r.status); e.code = r.status; e.detail = (j && j.error && j.error.message) || raw.slice(0, 160); throw e; }
  let text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  text = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^<think>[\s\S]*$/, '').trim();
  if (!text) { const m0 = (j && j.choices && j.choices[0]) || {}; const e = new Error('empty reply'); e.code = 'empty';
    e.detail = `finish=${m0.finish_reason} content=${JSON.stringify(m0.message && m0.message.content).slice(0, 120)} reasoningChars=${String((m0.message && (m0.message.reasoning || '')) || '').length}`; throw e; }
  // if the model was cut off mid-sentence, end at the last full sentence
  const fin = j.choices[0].finish_reason;
  if (fin === 'length') { const cut = text.search(/[.!?…~)](?=[^.!?…~)]*$)/); if (cut > 20) text = text.slice(0, cut + 1); }
  return text;
}
async function askModel(system, messages) {
  if (!KEY) { const e = new Error('no_key'); e.status = 503; throw e; }
  if (Date.now() < dailyLimitUntil) { const e = new Error('daily_limit'); e.status = 429; throw e; }
  let lastErr; const tries = []; lastTries = tries;
  for (const model of await candidates()) {
    try {
      const text = await tryModel(model, system, messages);
      if (model !== lastGood) console.log(`AI is answering with: ${model}`);
      lastGood = model; return text;
    } catch (e) {
      lastErr = e;
      if (e.code === 401) { console.error('OpenRouter says the API key is wrong or switched off (401). Make a new key at https://openrouter.ai/keys, put it in .env, then restart (Ctrl + C, npm.cmd start).'); break; }
      if (e.code === 429 && /per-day|per day|daily/i.test(e.detail || '')) {
        console.error('You have used up today\'s free AI messages on OpenRouter (free accounts get about 50 a day). It resets at midnight UTC (7 am in Vietnam). Until then the friends use their built-in replies.');
        dailyLimitUntil = Date.now() + 15 * 60000; break;
      }
      console.error(`${model} did not answer (${e.code === 429 ? 'busy right now' : e.code === 404 ? 'no longer available' : e.code === 'empty' ? 'sent an empty reply' : e.message}); trying another free model…`);
      tries.push({ model, error: String(e.code || e.message), detail: String(e.detail || '').slice(0, 300) });
      if (model === lastGood) lastGood = null;
    }
  }
  const e = new Error(lastErr ? lastErr.message : 'no model'); e.status = 502; throw e;
}

// --- Spotify: official Web API, "client credentials" (no user login, the secret stays on the server) ---
let spToken = null, spExp = 0;
const spCache = new Map(); // small cache so the same playlist is not fetched again and again
async function spotifyToken() {
  if (spToken && Date.now() < spExp - 60000) return spToken;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(SP_ID + ':' + SP_SECRET).toString('base64') },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) { const e = new Error('spotify_auth ' + r.status); e.status = 502; throw e; }
  const j = await r.json(); spToken = j.access_token; spExp = Date.now() + j.expires_in * 1000; return spToken;
}
async function spGet(url) {
  const r = await fetch('https://api.spotify.com/v1' + url, { headers: { Authorization: 'Bearer ' + await spotifyToken() }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const e = new Error('spotify ' + r.status); e.status = r.status === 404 ? 404 : 502; throw e; }
  return r.json();
}
const spTrack = (t, alb) => t && t.uri && t.uri.startsWith('spotify:track:') ? {
  uri: t.uri, name: t.name, ms: t.duration_ms,
  artists: (t.artists || []).map(a => a.name).join(', '),
  album: (alb || t.album || {}).name || '',
  image: (((alb || t.album || {}).images || []).slice(-2)[0] || {}).url || ''
} : null;
async function spotify(req, res) {
  const ip = req.socket.remoteAddress || 'x';
  if (limited(ip)) return send(res, 429, { error: 'slow_down' });
  if (!SP_ID || !SP_SECRET) return send(res, 503, { error: 'no_spotify_keys' });
  const q = new URL(req.url, 'http://x').searchParams, type = q.get('type'), id = q.get('id') || '';
  if (!['track', 'album', 'playlist', 'artist'].includes(type) || !/^[A-Za-z0-9]{10,40}$/.test(id)) return send(res, 400, { error: 'bad_link' });
  const key = type + ':' + id, hit = spCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return send(res, 200, hit.data);
  try {
    let data;
    if (type === 'track') { const t = await spGet('/tracks/' + id); data = { name: t.name, tracks: [spTrack(t)] }; }
    else if (type === 'album') { const a = await spGet('/albums/' + id); data = { name: a.name, tracks: a.tracks.items.map(t => spTrack(t, a)) }; }
    else if (type === 'artist') { const [a, t] = await Promise.all([spGet('/artists/' + id), spGet('/artists/' + id + '/top-tracks?market=US')]); data = { name: a.name + ' · top songs', tracks: t.tracks.map(x => spTrack(x)) }; }
    else { const p = await spGet('/playlists/' + id + '?fields=name,tracks.items(track(uri,name,duration_ms,artists(name),album(name,images)))'); data = { name: p.name, tracks: p.tracks.items.map(i => spTrack(i.track)) }; }
    data.tracks = data.tracks.filter(Boolean).slice(0, 100);
    spCache.set(key, { at: Date.now(), data }); if (spCache.size > 200) spCache.delete(spCache.keys().next().value);
    send(res, 200, data);
  } catch (e) { console.error('Spotify error:', e.message); send(res, e.status || 500, { error: e.message }); }
}

async function api(req, res) {
  const ip = req.socket.remoteAddress || 'x';
  if (limited(ip)) return send(res, 429, { error: 'slow_down' });
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
  const messages = cleanMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return send(res, 400, { error: 'need_user_message' });
  try {
    if (req.url === '/api/chat') {
      const persona = PERSONAS[body.persona];
      if (!persona) return send(res, 400, { error: 'unknown_character' });
      const who = String(body.name || 'friend').slice(0, 30);
      const system = `${LORE}\n\nThe user's name is ${who}.\n\nYour character: ${persona}\n\nWrite ONLY your next chat message. No narration, no quotes, no name prefix.`;
      return send(res, 200, { reply: await askModel(system, messages) });
    }
    if (req.url === '/api/assistant') return send(res, 200, { reply: await askModel(ASSISTANT, messages) });
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('AI error:', e.message);
    send(res, e.status || 500, { error: e.message });
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/api/chat' || req.url === '/api/assistant')) return api(req, res);
  if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ok: true, version: VERSION, ai: !!KEY, model: MODEL, spotify: !!(SP_ID && SP_SECRET), convexUrl: CONVEX_URL || null });
  if (req.method === 'GET' && req.url === '/convex.js') { // the Convex library for the browser, from node_modules (npm install convex)
    return fs.readFile(CONVEX_LIB, (err, data) => {
      if (err) { res.writeHead(302, { Location: 'https://unpkg.com/convex@1/dist/browser.bundle.js' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(data);
    });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/spotify?')) return spotify(req, res);
  if (req.method === 'GET' && req.url === '/api/selfcheck') { // only answers on your own computer; never shows the key
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')) return send(res, 403, { error: 'local only' });
    return (async () => { const out = { version: VERSION, model: MODEL, lastGood, candidates: await candidates(), freeModels: (freeList || []).length, results: [] };
      for (const m of out.candidates) { const t0 = Date.now(); try { const r = await tryModel(m, LORE + '\n\nYour character: ' + PERSONAS.lumi + '\n\nWrite ONLY your next chat message.', [{ role: 'user', content: 'hi! do you remember me?' }]); out.results.push({ model: m, ok: true, secs: (Date.now() - t0) / 1000, reply: r.slice(0, 200) }); }
        catch (e) { out.results.push({ model: m, ok: false, secs: (Date.now() - t0) / 1000, error: String(e.code || e.message), detail: String(e.detail || '').slice(0, 300) }); } }
      send(res, 200, out); })();
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already being used, so XPerience is probably already running in another terminal.`);
    console.error('Stop the old one first: press Ctrl + C in that terminal, or run:  taskkill /F /IM node.exe');
    console.error('Then start again with:  npm.cmd start\n');
    process.exit(1);
  }
  throw e;
}).listen(PORT, () => {
  console.log(`XPerience is running: http://localhost:${PORT}`);
  if (KEY) console.log(`API key in use: ${KEY.slice(0, 9)}…${KEY.slice(-4)}  (check that this matches the end of your key in .env)`);
  console.log(KEY ? `AI model: ${MODEL}` : 'No API key found. Put OPENROUTER_API_KEY in the .env file. (The site still works with built-in replies.)');
  console.log(SP_ID && SP_SECRET ? 'Spotify connection: on' : 'Spotify connection: off (optional, see README)');
  console.log(CONVEX_URL ? `XPerience Online (Convex): ${CONVEX_URL}` : 'XPerience Online: off (run "npx.cmd convex dev" once, see README)');
});
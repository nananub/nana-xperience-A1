// XPerience back end: a tiny dependency-free Node server.
// - serves the front end from /public
// - POST /api/chat       -> a friend (Lumi, Bit_Bunny, Mx. Pixel, tide_pool) replies using an AI model
// - POST /api/assistant  -> the Ask-O-Tron 2000 robot replies (knowledge ends Dec 2014)
// The API key is read from the environment (.env) and NEVER sent to the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LORE, PERSONAS, ASSISTANT } = require('./personas');

// --- tiny .env loader (so you don't need any npm packages) ---
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file */ }

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.MODEL || 'liquid/lfm-3-1.7b:free';
const BASE = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
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

async function askModel(system, messages) {
  if (!KEY) { const e = new Error('no_key'); e.status = 503; throw e; }
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, max_tokens: 180, temperature: 0.9, messages: [{ role: 'system', content: system }, ...messages] }),
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) { const e = new Error('upstream ' + r.status); e.status = 502; throw e; }
  const j = await r.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) { const e = new Error('empty'); e.status = 502; throw e; }
  return String(text).trim();
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
  if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ok: true, ai: !!KEY, model: MODEL });
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
}).listen(PORT, () => {
  console.log(`XPerience is running: http://localhost:${PORT}`);
  console.log(KEY ? `AI model: ${MODEL}` : 'No API key found. Put OPENROUTER_API_KEY in the .env file. (The site still works with built-in replies.)');
});

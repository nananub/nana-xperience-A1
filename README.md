# XPerience.exe

Front end: `public/index.html` (the whole retro desktop).
Back end: `server.js` (Node, no packages needed). It keeps the API key secret and calls the AI model for:

- the Chatzee friends (`POST /api/chat`)
- the Ask-O-Tron 2000 robot (`POST /api/assistant`)

## Run it
1. Install Node.js (https://nodejs.org, the LTS version).
2. Copy `.env.example` to `.env` and paste your OpenRouter key after `OPENROUTER_API_KEY=`.
3. In a terminal inside this folder: `npm start`
4. Open http://localhost:3000

If there is no key or the model is unreachable, the site still works with built-in replies.

## Security
The key lives only in `.env` (listed in `.gitignore`, so it never goes to GitHub). The browser only talks to `/api/...`.

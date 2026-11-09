# XPerience.exe

Front end: `public/index.html` (the whole retro desktop).
Back end: `server.js` (Node, no packages needed). It keeps the API key secret and calls the AI model for:

- the Chatzee friends (`POST /api/chat`)
- the Ask-O-Tron 2000 robot (`POST /api/assistant`)
- Spotify track lists for the Media Player's iPod (`GET /api/spotify`, optional)

## Run it
1. Install Node.js (https://nodejs.org, the LTS version).
2. Copy `.env.example` to `.env` and paste your OpenRouter key after `OPENROUTER_API_KEY=`.
3. In a terminal inside this folder: `npm start`
4. Open http://localhost:3000

If there is no key or the model is unreachable, the site still works with built-in replies.

### Optional: Spotify playlists on the iPod
With this on, a Spotify playlist / album link shows up on the iPod as a song list, and the wheel's ◀◀ ▶▶ and Shuffle move between its songs.
1. Go to https://developer.spotify.com/dashboard, log in, and press **Create app** (any name; for "Redirect URI" you can type `http://127.0.0.1:3000`; tick "Web API").
2. Open the app's **Settings** and copy the **Client ID** and **Client secret**.
3. Paste them into `.env` after `SPOTIFY_CLIENT_ID=` and `SPOTIFY_CLIENT_SECRET=`, then restart `npm start`.

Without it, Spotify links still play, but inside a playlist you skip songs with Spotify's own buttons.
Note: Spotify no longer lets new apps read its own editorial playlists (the ones made by "Spotify", IDs starting with `37i9`); those fall back to Spotify's normal player. Playlists made by people work.
Spotify never lets other websites change its volume, so for Spotify use your computer's volume.

YouTube links need the site opened through `http://localhost:3000` (or your hosted link), not by double-clicking `index.html`.

## Security
The keys live only in `.env` (listed in `.gitignore`, so it never goes to GitHub). The browser only talks to `/api/...`.
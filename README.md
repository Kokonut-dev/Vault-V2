# Vault 🎬🎵

**Your movies, music, and videos. In one beautiful place. On your computer. Private.**

Vault is like Netflix + Spotify, but you own it. No cloud. No spying. Just your stuff.

---

## What You Need

1. **A computer** (Mac, Windows, Linux all work)
2. **Node.js** – get it here: https://nodejs.org (click the green button, install it)
3. **Your movies/music** – any files you already have

That's it.

---

## Setup in 3 Minutes

### Step 1: Get Vault

Open your Terminal (Mac: Spotlight → type Terminal, Windows: search `cmd`).

Copy-paste this:

```bash
git clone https://github.com/Kokonut-dev/Vault-V2.git
cd Vault-V2/server
npm install
```

Wait 30 seconds. Done.

### Step 2: Start the Server

Same window, type:

```bash
npm start
```

You should see:

```
Vault server running at http://localhost:4000
```

Leave this window open. Don't close it. This is your Vault server.

### Step 3: Open Vault

Open your browser (Chrome, Safari, Firefox) and go to:

```
https://kokonut-dev.github.io/Vault-V2/
```

**First time? You will see a magic wizard with 6 steps. Follow it:**

#### The 6 Steps (super easy):

**1. Welcome** → Click `Get Started`

**2. Connect to Server** → It says `http://localhost:4000`. Click `Test`. If it says `✓ Connected`, click `Continue`.

> Not connected? Make sure Step 2's window is still open and says "running".

**3. Create Account** → Pick a username (like `bob`) and a password (like `mysecret123`). Type it twice. Click `Continue`.

**4. Secret Grid** → You see 16 squares. Click **exactly 8** you will remember. Like a secret pattern. Example: click the 4 corners + 4 middle. Click `Continue`.

> **This is important!** Remember these 8 squares. It's your second password. Write it on paper if you need.

**5. Media & Look** → Pick a color theme (Dark is cool). Leave the movie/music/video folders as they are for now. Click `Continue`.

**6. Done!** → Check your info. Click `Complete Setup ✨`.

Boom. You're inside Vault!

---

## How to Add Your Movies & Music

You have 2 ways:

**Easy Way (in Vault):**
- Click `Upload` on the left
- Pick `Movie`, `Music`, or `Video`
- Drag your files in
- Click Upload

**Pro Way (copy files):**
- On your computer, find the folder: `Vault-V2/server/media/`
- Inside there are 3 folders: `movies`, `music`, `videos`
- Copy your files into them
- In Vault, go to `Settings` → `Trigger Library Scan`

Your stuff appears in a few seconds!

---

## How to Login Next Time

1. Make sure server is running (`npm start` in `server` folder)
2. Open https://kokonut-dev.github.io/Vault-V2/
3. Type username + password → `Continue`
4. Click your 8 secret squares → `Unlock Vault`

That's it.

---

## What Can You Do Inside?

- **Home** – See what you watched, new stuff, random pick
- **Movies / Music / Videos** – All your files, pretty cards
- **Play** – Click anything to play. Video player has speed, fullscreen, subtitles.
- **Music** – Bottom bar plays music even when you browse. Like Spotify.
- **Search** – Press `Alt + Space` (or `Option + Space` on Mac) and type anything
- **EQ** – In Settings, click `Open Equalizer` for bass boost
- **Themes** – In Settings, try Dark, Light, Warm, Cold. Move the Glass and Grain sliders.

---

## If Something Breaks

**"Cannot connect to Vault server"**
- Is your server window still open? If not, open Terminal, `cd Vault-V2/server`, `npm start` again.
- Is the URL right? In Vault login screen, click `Change` under Server and type `http://localhost:4000`

**"HTTPS vs HTTP error" (browser blocks)**
- Easiest fix: Don't use GitHub Pages. Run Vault locally:
  ```bash
  cd Vault-V2
  npx serve docs
  ```
  Then open `http://localhost:3000` – no more blocking.

**"Forgot my grid pattern?"**
- On your computer, open file `Vault-V2/server/config.json`
- Look for `gridPattern` – that's your 8 numbers

**"Locked out after 5 tries?"**
- Wait 15 minutes, or delete file `Vault-V2/server/data/bruteforce.json` and restart server.

---

## Want HTTPS? (For phone access)

If you want to open Vault from your phone outside home:

1. Install Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
2. Run: `cloudflared tunnel --url http://localhost:4000`
3. It gives you a link like `https://something.trycloudflare.com`
4. Use that link as your Server URL in Vault Settings.

Now your phone can connect.

---

## For Developers (optional)

```
server/
  npm run dev     → auto-reload server
  npm run setup   → old terminal setup wizard

docs/
  npx serve docs  → run frontend locally at http://localhost:3000
```

Backend API: `http://localhost:4000/api/health` and `/api/setup/status`

Onboarding is at `/api/setup/*` – it creates `config.json` with `enablement: true`

GitHub Pages deploy is in `.github/workflows/deploy.yml` – it checks onboarding files and `VAULT_ENABLEMENT=true`

---

## Security in Simple Words

- Your password is scrambled (hashed), no one can read it
- Your grid pattern is secret, like a PIN but with squares
- After 5 wrong tries, Vault locks for 15 minutes
- Nothing goes to the cloud, everything stays on your computer

---

## License

MIT – do whatever you want. See [LICENSE](LICENSE)

---

**Made with ❤️ – Your media, your server, your rules.**

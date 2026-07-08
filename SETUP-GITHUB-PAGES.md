# Deploying to GitHub Pages (and installing from it)

Revenge fetches a plugin's manifest through a **remote relay**, which can't reach
your localhost or LAN IP — that's why the tunnel and local-server installs failed
with nothing ever arriving at your machine. GitHub Pages hosts the plugin on a
public HTTPS URL the relay *can* reach, exactly like every other installable
Revenge plugin.

You do this once. After that, every code change is: build → push → reload.

## One-time setup

### 1. Create a repo and push

GitHub Pages on the free tier needs a **public** repo. That's fine here — the
source has no secrets, and your logs never leave your phone. (If you have GitHub
Pro, a private repo works too.)

```bash
cd <the extracted mlr folder>
git init
git add .
git commit -m "MessageLoggerRevenge v0.2"
git branch -M main
git remote add origin https://github.com/<your-user>/message-logger-revenge.git
git push -u origin main
```

(Create the empty repo on github.com first, then use its URL above.)

### 2. Turn on Pages with the Actions source

In the repo on github.com: **Settings → Pages → Build and deployment →
Source → "GitHub Actions"**.

That's the only Pages setting to touch. The workflow in
`.github/workflows/deploy.yml` builds the plugin and publishes `dist/` every time
you push to `main`.

### 3. Wait for the first deploy

Go to the **Actions** tab. You'll see the "Deploy plugin to GitHub Pages" run.
When it goes green (~1 minute), your plugin is live at:

```
https://<your-user>.github.io/message-logger-repo-name/MessageLoggerRevenge/
```

Concretely, if your user is `levity02` and the repo is `message-logger-revenge`:

```
https://levity02.github.io/message-logger-revenge/MessageLoggerRevenge/
```

Keep the trailing slash — the client appends `manifest.json`.

### 4. Install in Revenge

Plugins page → install from URL → paste the Pages URL above. It should install
cleanly this time, because the relay can reach github.io. Enable it, open its
settings, and tap **Run self-check** first.

## The iteration loop from here

Edit code, then:

```bash
git add -A && git commit -m "..." && git push
```

Wait for the Actions run to go green (~1 min), then in Revenge disable/re-enable
the plugin (or reload) to pull the new bundle. The manifest hash changes on every
build, which is what tells the client to re-download.

### Optional: faster loop without the CI wait

If the ~1-minute CI wait per change gets annoying, you can publish straight from
your machine instead. This uses the `gh-pages` branch rather than the Actions
source, so if you go this route, switch **Settings → Pages → Source** to
**"Deploy from a branch" → `gh-pages` / root**, and use it via:

```bash
npm run deploy
```

That builds locally and pushes `dist/` to the `gh-pages` branch in ~15 seconds.
Pick one approach — Actions *or* branch deploy — not both, since they use
different Pages source settings.

## If the install still errors now

Since the relay will finally be able to fetch the manifest, any *new* error would
be about the manifest contents rather than reachability. If that happens, copy me
the exact error text and I'll adjust the manifest — but the format here matches
the standard Revenge plugin layout, so it should go through.

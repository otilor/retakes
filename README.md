# Orchestrator

Point at your running app, say what to change, and Claude Code builds it in a separate copy of your project while you watch. Try a few takes, flip between them on the same URL, compare two side by side, and keep the one you like.

It's for one developer working on a Vite app with Claude Code. Nothing to set up in your app, and nothing ships in your build.

## Start

In your app's folder:

```sh
npx github:otilor/orchestrator
```

That starts your dev server behind a hub at **http://localhost:4300** and opens it. Your app looks the same, with a small dock at the bottom of the page.

### You need

- Node 18.17 or newer, and git
- Your app in a git repository with at least one commit
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in your terminal)
- A Vite app. React apps also get the component name and file when you point at something. Other dev servers work with one line of config (see below).
- macOS or Linux. Windows hasn't been tested yet.

## Use it

| To | Do this |
| --- | --- |
| Ask for a change | Click the pointer in the dock, click the part of the page, type what you want, press **Enter**. Or press Enter without pointing to describe it in words. |
| Watch it happen | The new tile spins while Claude works. Click it to switch to that take; edits land live as Claude makes them. |
| Switch between versions | Click a tile. You stay on the same page, at the same scroll, still signed in. |
| Refine a take | Open its tile and type in **Ask agent-N**. It continues the same Claude session, so it remembers what it did. |
| Try another take | **Try another** runs the same request again, asking for a different approach. |
| Compare | The split-screen button shows two versions side by side and scrolls them together. |
| Fix errors | If a take throws in the browser, its tile gets a badge. **Fix** sends the errors back to that take's Claude session. |
| Keep one | **Keep** merges the take into the branch you have checked out, as one merge commit, then removes it. |
| Throw one away | **Discard** deletes the take, its folder and its branch. |

Notifications (done, failed, errors, kept) appear at the top of the page via [Notch](https://notch.devsethi.me/). Press **.** to hide or show the dock, and **Esc** to close panels. Drag the dock by its handle to any edge; right-click the handle for theme and position.

## What it costs

Each request is one headless Claude Code run, billed to your Claude account like any other. Takes use **Sonnet** by default, which handles UI work well for a fraction of Opus's price. The cost of each take shows in its panel. A typical small change costs a few cents; set `"agent": { "model": "haiku" }` to go cheaper or `"opus"` for harder changes.

## How it works

- **Each take is a git worktree** under `~/.orch/projects/<app>/takes/`, on its own branch `orch/take-N`, started from your current commit. Your working folder is never touched until you Keep. Your `.env` files are copied in; dependencies are installed with your package manager and lockfile.
- **Each take gets its own dev server** on a private port, so hot reload works in every take at once.
- **The hub is one origin for all of them.** It proxies to whichever version you're viewing, chosen by a cookie, so switching keeps your URL, cookies and localStorage. It also injects the dock into HTML pages; your app's code is unchanged.
- **Claude Code runs headless** in the take's folder: `claude -p --output-format stream-json --permission-mode acceptEdits --model sonnet`. It can edit files there; anything else follows your Claude Code permission settings. Orchestrator commits its work after each run.
- The hub listens on 127.0.0.1 only and every API call needs a per-run token.

## Config

Optional. Put `orch.config.json` in your app's folder:

```jsonc
{
  "port": 4300,                              // the hub's port
  "dev": "npm run dev -- --port {port}",     // only for non-Vite dev servers
  "setup": "npm ci",                         // runs in each new take instead of the detected install
  "copy": [".env.local"],                    // files copied into each take (default: .env*)
  "agent": {
    "model": "haiku",                        // sonnet by default
    "args": ["--max-turns", "30"]            // extra Claude Code flags
  }
}
```

## Commands

```sh
orch                # start (the default)
orch --port 4400    # pick the hub's port
orch --no-open      # don't open the browser
orch clean          # remove every take: its folder, its branch and saved state
```

Takes survive restarts. Stop with Ctrl+C and run `orch` again to pick up where you left off.

## Good to know

- In Compare, each pane runs on its own port, so the panes don't share your sign-in or localStorage with the main view.
- Keep merges into whatever branch your main folder has checked out. If that would conflict, nothing changes and you get a message saying why.
- The dock is about 130 KB gzipped and only loads through the hub on localhost.

## Develop

```sh
npm install
npm run build      # bundles the dock into dist/dock.js
npm test           # unit tests
npm run test:e2e   # every flow end to end in a real browser, with a stand-in agent
```

## License

MIT

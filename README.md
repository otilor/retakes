# Retakes

Point at your running app, say what to change, and Claude Code builds it in a separate copy of your project while you watch. Try a few takes, flip between them on the same URL, compare two side by side, and keep the one you like.

It's for one developer working on a Vite or Next.js app with Claude Code. Nothing to set up in your app, and nothing ships in your build.

## Start

In your app's folder:

```sh
npx retakes
```

That starts your dev server behind a hub at **http://localhost:4300** and opens it. Your app looks the same, with a small dock at the bottom of the page.

### You need

- Node 18.17 or newer, and git
- Your app in a git repository with at least one commit
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in your terminal)
- A Vite or Next.js app. React apps also get the component name (and, with Vite, the file) when you point at something. Other dev servers work with one line of config (see below).
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
| Record a flow | Press **F**, then **Record a flow**, and use the page the way you'd test it: type, click, press Enter. **Add check** picks text that should be on the page. Press **Done** and name it. |
| Catch broken flows | When a take's agent finishes, your flows replay on it in the background. If a take breaks one that still passes on main, its tile gets a badge, and **Fix** sends the flow and the failing step to its agent. |
| Keep one | **Keep** merges the take into the branch you have checked out, as one merge commit, then removes it. |
| Throw one away | **Discard** deletes the take, its folder and its branch. |

Notifications (done, failed, errors, kept) appear at the top of the page via [Notch](https://notch.devsethi.me/). Press **P** to point and prompt, **C** to compare, **F** for flows, **.** to hide or show the dock, and **Esc** to close panels. Drag the dock by its handle to any edge; right-click the handle for theme and position.

## Whose Claude it uses

Retakes has no API key of its own. Each request is one headless run of your own Claude Code, signed in as you, so it counts against your Claude plan (or your API key, if Claude Code uses one). Takes use **Sonnet** by default, which handles UI work well. Runs are tuned for quick UI edits: low effort, no MCP servers, no subagents or web lookups. Set `"agent": { "model": "haiku" }` for lighter use, `"opus"` for harder changes, or `"effort": "high"` when a change needs more thought.

## Flows

A flow is a short user journey you record once, like "search for Lisbon, clear the filters, check it says No filters". Retakes replays every flow with [Playwright](https://playwright.dev) on each take after its agent finishes, headless and in the background, against that take's own dev server. A failure only counts against a take if the same flow passes on main.

- **Watch** in the Flows panel plays a flow on the page you're looking at, step by step, highlighting each element, so you can see what it does and where it breaks.
- Flows are saved in your app at `.retakes/flows/<name>.json`, next to a generated `<name>.spec.mjs` Playwright test you can run in CI. Commit them to share them.
- Each step remembers a few ways to find its element (test ids, labels, roles, then its position), so a take that only restyles or renames a button doesn't break the flow. Checks are strict: if the text changes, the check fails.
- Replays use your app's own Playwright if it has one. Otherwise Retakes installs `playwright-core` once into `~/.retakes/runtime`, and uses your Chrome or Edge. It downloads a browser (about 150 MB) only if you have neither.
- Flows run against your dev servers, so a flow that saves data saves it each time it runs.

## How it works

- **Each take is a git worktree** under `~/.retakes/projects/<app>/takes/`, on its own branch `retakes/take-N`, started from your current commit. Your working folder is never touched until you Keep. Your `.env` files are copied in; dependencies are installed with your package manager and lockfile.
- **Each take gets its own dev server** on a private port, so hot reload works in every take at once.
- **The hub is one origin for all of them.** It proxies to whichever version you're viewing, chosen by a cookie, so switching keeps your URL, cookies and localStorage. It also injects the dock into HTML pages; your app's code is unchanged.
- **Claude Code runs headless** in the take's folder: `claude -p --output-format stream-json --permission-mode acceptEdits --model sonnet`. It can edit files there; anything else follows your Claude Code permission settings. Retakes commits its work after each run.
- The hub listens on 127.0.0.1 only and every API call needs a per-run token.

## Config

Optional. Put `retakes.config.json` in your app's folder:

```jsonc
{
  "port": 4300,                              // the hub's port
  "dev": "npm run dev -- --port {port}",     // only for dev servers other than Vite and Next.js
  "setup": "npm ci",                         // runs in each new take instead of the detected install
  "copy": [".env.local"],                    // files copied into each take (default: .env*)
  "agent": {
    "model": "haiku",                        // sonnet by default
    "effort": "medium",                      // low by default, for quick edits
    "args": ["--max-turns", "30"]            // extra Claude Code flags
  }
}
```

## Commands

```sh
retakes                # start (the default)
retakes --port 4400    # pick the hub's port
retakes --no-open      # don't open the browser
retakes clean          # remove every take: its folder, its branch and saved state
```

Takes survive restarts. Stop with Ctrl+C and run `retakes` again to pick up where you left off.

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
npm run test:e2e:next  # the same on a Next.js app
npm run test:e2e:flows # recording a flow in the dock and replaying it on takes
```

## License

MIT

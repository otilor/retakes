# Retakes

[![npm version](https://img.shields.io/npm/v/retakes.svg)](https://www.npmjs.com/package/retakes)
![Node version](https://img.shields.io/node/v/retakes.svg)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Point at your running app, say what to change, and watch Claude Code build it live. Try a few takes, flip between them on the same URL, and keep the one you like.

[![Retakes demo: point at the pricing cards, ask Claude Code for a change, watch it land live, try another take, flip between takes, compare and keep](https://raw.githubusercontent.com/otilor/retakes/main/docs/demo.gif)](docs/demo.mp4)

▶ [Watch the demo with sound](docs/demo.mp4). Everything in it is a real run on a small demo app; only the waiting is sped up.

Retakes is for one developer working on a Vite or Next.js app with Claude Code. There's nothing to set up in your app, and nothing ships in your build.

## Quick start

In your app's folder:

```sh
npx retakes
```

That starts your dev server behind a hub at **http://localhost:4300** and opens it. Your app looks the same, with a small dock at the bottom of the page. Press **P**, click something, type what you want, and press **Enter**.

> [!NOTE]
> You need Node 18.17 or newer, git, and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in your terminal). Your app must be in a git repository with at least one commit. Tested on macOS and Linux; Windows isn't tested yet.

## Features

- **Prompt by pointing.** Click a part of the page and describe the change. React apps also send the component name (and, with Vite, the file).
- **Watch it land.** Each request runs in its own copy of your project, and edits appear live through hot reload.
- **Switch in place.** Click a tile to view another take on the same URL, at the same scroll, still signed in.
- **Try another.** Run the same request again for a different approach, or keep refining a take in the same Claude session.
- **Compare.** Two versions side by side, scrolling together.
- **Switch models and effort.** Pick Haiku, Sonnet or Opus and an effort level right in the dock. Each take shows what it ran on, so you can try the same request on two models and compare.
- **Fix errors in one click.** Takes that throw in the browser get a badge, and **Fix** sends the errors back to that take's agent.
- **Flows.** Record a user journey once, and Retakes replays it with Playwright on every take to catch what broke.
- **Keep or discard.** Keep merges a take into your branch as one commit; Discard deletes it.

## Usage

| To | Do this |
| --- | --- |
| Ask for a change | Press **P** (or click the pointer), click the part of the page, type, press **Enter**. Press Enter without pointing to describe it in words. |
| Switch versions | Click a tile in the dock. |
| Refine a take | Open its tile and type in **Ask agent-N**. It continues the same Claude session. |
| Try another take | **Try another** reruns the request, asking for a different approach. |
| Switch model or effort | In the **Ask for a change** panel, pick a model and an effort level. New runs use them, including follow-ups, Fix and Try another; Retakes remembers the pick for this app. |
| Compare | Press **C**, or click the split-screen button. |
| Fix errors | Click **Fix** on a badged tile. |
| Record a flow | Press **F**, then **Record a flow**, and use the page the way you'd test it. **Add check** picks text that should be on the page. |
| Keep one | **Keep** merges the take into the branch you have checked out. |
| Throw one away | **Discard** removes the take, its folder and its branch. |

Press **.** to hide or show the dock and **Esc** to close panels. Drag the dock by its handle to any edge; right-click the handle for theme and position.

### Commands

```sh
retakes                # start (the default)
retakes --port 4400    # pick the hub's port
retakes --no-open      # don't open the browser
retakes --model opus --effort high   # start on another model and effort (replaces the dock's saved pick)
retakes clean          # remove every take: its folder, its branch and saved state
```

Takes survive restarts. Stop with Ctrl+C and run `retakes` again to pick up where you left off.

### Configuration

Optional. Put `retakes.config.json` in your app's folder:

```jsonc
{
  "port": 4300,                              // the hub's port
  "dev": "npm run dev -- --port {port}",     // only for dev servers other than Vite and Next.js
  "setup": "npm ci",                         // runs in each new take instead of the detected install
  "copy": [".env.local"],                    // files copied into each take (default: .env*)
  "agent": {
    "model": "haiku",                        // the default model; sonnet if unset
    "effort": "medium",                      // the default effort; low if unset, for quick edits
    "args": ["--max-turns", "30"]            // extra Claude Code flags
  }
}
```

## Whose Claude it uses

Retakes has no API key of its own. Each request is one headless run of your own Claude Code, signed in as you, so it counts against your Claude plan (or your API key, if Claude Code uses one).

> [!TIP]
> Takes use **Sonnet** at low effort by default, tuned for quick UI edits. Switch to Haiku for lighter use, Opus for harder changes, or a higher effort when a change needs more thought, from the dock, with `--model`/`--effort`, or as the default in `"agent"` in the config. A pick in the dock wins over the config until you change it.

## Flows

A flow is a short user journey, like "search for Lisbon, clear the filters, check it says No filters". When a take's agent finishes, Retakes replays every flow on it with [Playwright](https://playwright.dev), headless and in the background. A failure only counts against a take if the same flow passes on main, and **Fix** sends the failing step to that take's agent.

- **Watch** in the Flows panel plays a flow on the page step by step, highlighting each element.
- Flows are saved in `.retakes/flows/<name>.json`, next to a generated `<name>.spec.mjs` Playwright test you can run in CI. Commit them to share.
- Steps remember several ways to find their element (test ids, labels, roles, position), so restyling a button doesn't break a flow. Checks are strict about text.
- Retakes uses your app's Playwright if it has one. Otherwise it installs `playwright-core` once into `~/.retakes/runtime` and uses your Chrome or Edge.

> [!WARNING]
> Flows run against your dev servers, so a flow that saves data saves it each time it runs.

## How it works

- **Each take is a git worktree** under `~/.retakes/projects/<app>/takes/`, on its own branch `retakes/take-N`, started from your current commit. Your working folder isn't touched until you Keep. Your `.env` files are copied in, and dependencies are installed with your package manager.
- **Each take gets its own dev server** on a private port, so hot reload works in every take at once.
- **The hub is one origin for all of them.** It proxies to the version you're viewing, chosen by a cookie, so switching keeps your URL, cookies and localStorage. It injects the dock into HTML pages; your app's code is unchanged.
- **Claude Code runs headless** in the take's folder with `--permission-mode acceptEdits`. It can edit files there; anything else follows your Claude Code permission settings. Retakes commits its work after each run.
- The hub listens on 127.0.0.1 only, and every API call needs a per-run token.

> [!NOTE]
> In Compare, each pane runs on its own port, so panes don't share your sign-in or localStorage with the main view. Keep refuses to merge if it would conflict, and tells you why.

## Development

```sh
npm install
npm run build             # bundles the dock into dist/dock.js
npm test                  # unit tests
npm run test:e2e          # end to end in a real browser, with a stand-in agent
npm run test:e2e:next     # the same on a Next.js app
npm run test:e2e:flows    # recording a flow and replaying it on takes
```

Releases publish to npm from a `v*` tag through the [Release workflow](.github/workflows/release.yml).

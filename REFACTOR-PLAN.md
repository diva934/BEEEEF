# BEEEF — Safe Refactor Plan
_Architecture analysis · April 2026 · No files modified yet_

---

## How to use this document

Each issue has a **Risk** rating (🔴 High / 🟠 Medium / 🟡 Low) and an **Action** column.
The execution order is numbered. Do not skip ahead — earlier steps expose problems that block later ones.

---

## Part 1 — Deployment configuration conflicts

These are the most dangerous issues because they determine *what actually runs on legacy-deploy*.

### Issue 1 — Duplicate legacy-deploy.json files (🔴 High)

| File | `startCommand` |
|---|---|
| `/legacy-deploy.json` (root) | `npm start` → runs `node server/server.js` |
| `/server/legacy-deploy.json` | `node server.js` (relative, runs from `server/`) |

**What happens:** legacy-deploy picks up one of these. If it picks the root one it works correctly. If it picks `server/legacy-deploy.json` it also works, but only because `server.js` there is the real server file. In practice the root file wins, but having two is a maintenance trap — the next person to edit `server/legacy-deploy.json` thinking it's the active one will break the deploy silently.

**Fix (Step 1):** Delete `/server/legacy-deploy.json`. Keep only the root one.

---

### Issue 2 — Duplicate Procfile files (🔴 High)

| File | Command |
|---|---|
| `/Procfile` (root) | `web: npm start` |
| `/server/Procfile` | `web: node server.js` |

Same problem as above — two sources of truth. The root Procfile wins on legacy-deploy (since `rootDirectory` is not set), but `/server/Procfile` will confuse any tooling that scans the repo.

**Fix (Step 2):** Delete `/server/Procfile`. Keep only the root one.

---

### Issue 3 — Missing `stripe` dependency in `/server/package.json` (🟠 Medium)

`/package.json` (root) lists `stripe` as a dependency. `/server/package.json` does not.

legacy-deploy runs `npm start` from the root, so it installs from `/package.json` — `stripe` is present. But if anyone ever deploys from the `server/` subdirectory (or if legacy-deploy's build detection changes), `require('stripe')` inside `server/stripe.js` will throw at startup.

**Fix (Step 3):** Add `"stripe": "^X.Y.Z"` to `/server/package.json` with the same version as the root.

---

## Part 2 — Frontend bugs in sync.js

These bugs exist in the running production frontend. They are safe to fix independently of the server.

### Issue 4 — `getLogoutButton()` defined twice (🟡 Low)

Lines 738 and 747 both define `getLogoutButton`. The second definition silently shadows the first. JavaScript doesn't error on this — the second one wins. Currently both definitions are identical so there is no visible bug, but this will bite you the moment someone edits one and not the other.

**Fix (Step 4):** Delete the first (lines ~738) definition; keep the second.

---

### Issue 5 — `handleLogout()` defined twice (🟡 Low)

Same pattern at lines 946 and 960. Same risk as Issue 4.

**Fix (Step 5):** Delete the first definition; keep the second.

---

### Issue 6 — `setAuthFormEnabled` inverts the `enabled` flag (🟠 Medium)

```js
// Line 774 — current (WRONG)
submitButton.disabled = false;

// Should be
submitButton.disabled = !enabled;
```

When `setAuthFormEnabled(false)` is called (e.g., while the auth request is in flight), the submit button is supposed to be disabled. Currently it's always enabled, so users can double-submit the login form, potentially firing duplicate Supabase auth requests.

**Fix (Step 6):** Change `submitButton.disabled = false` → `submitButton.disabled = !enabled`.

---

## Part 3 — Frontend dead code

These are not bugs — the app works without touching them — but they are cleanup candidates.

### Issue 7 — WebRTC code unreachable in index.html.html (🟡 Low)

`rtcJoinRoom()` at line 5384 immediately does:
```js
return Promise.reject(new Error('broadcast-only'));
```
Every line of WebRTC logic after that (hundreds of lines of `RTCPeerConnection`, ICE candidate handlers, etc.) is permanently unreachable. It ships as dead bytes to every user.

**Fix (Step 7, optional):** Strip the unreachable block. Safe to do at any time; no other code path leads into it.

---

### Issue 8 — Anthropic API called from frontend without a key (🟡 Low)

Line 4620 makes a direct `fetch` to the Anthropic API. There is no API key in the request headers, so the call always fails with 401. The code then silently falls through to a local verdict-generation fallback, which is what actually runs.

This is not a user-visible bug today, but it wastes a round-trip on every verdict generation and exposes the intent to put an API key here in future (which would be a security risk — API keys must never ship in client-side code).

**Fix (Step 8):** Remove the `fetch` to Anthropic entirely and keep only the local fallback. If AI verdicts are desired in future, proxy the call through the legacy-deploy backend.

---

## Execution order

```
Step 1  Delete /server/legacy-deploy.json
Step 2  Delete /server/Procfile
Step 3  Add stripe to /server/package.json
Step 4  Remove duplicate getLogoutButton in sync.js
Step 5  Remove duplicate handleLogout in sync.js
Step 6  Fix setAuthFormEnabled disabled flag in sync.js
Step 7  (Optional) Strip dead WebRTC block from index.html.html
Step 8  (Optional) Remove dead Anthropic fetch from index.html.html
```

Steps 1–3 are server/deploy side — commit them together.
Steps 4–6 are frontend (`sync.js`) — commit them together.
Steps 7–8 are frontend (`index.html.html`) — optional, commit separately.

---

## What NOT to change

- `server.js` (root) — it's a one-line proxy (`require('./server/server')`). Harmless, leave it.
- `vercel.json` — SPA routing is correct as-is.
- `/legacy-deploy.json` (root) — correct, keep.
- Any UI/UX in `index.html.html` beyond the dead-code removal above.
- `patch.js` / `sync.js` auth flow logic — out of scope here.

---

## Risks summary

| # | Risk | Severity | Notes |
|---|---|---|---|
| 1 | Dual legacy-deploy.json | 🔴 | Silent deploy misconfiguration |
| 2 | Dual Procfile | 🔴 | Same as above |
| 3 | Missing stripe dep | 🟠 | Breaks cold legacy-deploy boot if directory changes |
| 4 | Double getLogoutButton | 🟡 | Shadow bug, no user impact yet |
| 5 | Double handleLogout | 🟡 | Shadow bug, no user impact yet |
| 6 | setAuthFormEnabled bug | 🟠 | Double-submit on login form possible |
| 7 | Dead WebRTC code | 🟡 | Bloat only, no functional impact |
| 8 | Dead Anthropic fetch | 🟡 | Wasted round-trip, no user impact |

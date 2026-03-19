# Simple PO Editor

Simple PO Editor is a browser-based `.po` file editor for small teams that want a sharable web UI, anonymous lock-based editing, and `.po` export without adding sign-in.

## What it does

- Import a `.po` file in the browser and create a shareable document link
- Show one active editor lock at a time, with read-only fallback for everyone else
- Keep document data in the app backend, then export back to `.po`
- Work locally with no cloud setup through the included in-memory dev server
- Deploy to Cloudflare Pages Functions later and back the app with D1 for real persistence

## Local run

```bash
npm run dev
```

Then open [http://localhost:8787](http://localhost:8787).

Notes:

- Local dev uses an in-memory store, so data resets when the dev server restarts.
- The API shape already matches the Cloudflare Functions deployment path.

## Cloudflare Pages deployment

1. Push this repo to GitHub.
2. Create a Cloudflare Pages project from this repository.
3. Leave the build command blank.
4. Use the repository root as the build output directory.
5. Add a D1 binding named `DB`.
6. Apply [`schema.sql`](./schema.sql) to that D1 database.

After the `DB` binding exists, the Functions switch from memory mode to durable D1 storage automatically.

## Locking behavior

- No sign-in is required.
- Each browser gets a local anonymous `sessionId`.
- A user clicks `Take editing lock` to enter edit mode.
- The lock refreshes while the editor page is open.
- Other users can open the same document read-only until the lock is released or expires.

## Current MVP limits

- Obsolete `#~` entries are not preserved in this first version.
- The editor focuses on the common `msgid`, `msgctxt`, `msgid_plural`, and `msgstr[n]` workflow.
- Header fields are preserved and displayed, but not edited in the UI yet.

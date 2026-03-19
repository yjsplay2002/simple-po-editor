# Simple PO Editor

Simple PO Editor is a browser-based `.po` file editor for small teams that want a sharable web UI, anonymous lock-based editing, and `.po` export without adding sign-in.

## What it does

- Import a `.po` file in the browser and create a shareable document link
- Show one active editor lock at a time, with read-only fallback for everyone else
- Keep document data in the app backend, then export back to `.po`
- Work locally with no cloud setup through the included in-memory dev server
- Deploy to Cloudflare Pages Functions and back the app with D1 for real persistence

## Local run

```bash
npm run dev
```

Then open [http://localhost:8787](http://localhost:8787).

Notes:

- Local dev uses an in-memory store, so data resets when the dev server restarts.
- The API shape already matches the Cloudflare Functions deployment path.
- Production-style deployments must provide a D1 binding named `DB`.

## Cloudflare Pages deployment

Follow the detailed guide in [`docs/cloudflare-pages-setup.md`](./docs/cloudflare-pages-setup.md).

Short version:

1. Create a D1 database in Cloudflare.
2. Apply [`schema.sql`](./schema.sql) or [`migrations/0001_initial.sql`](./migrations/0001_initial.sql).
3. Create a Cloudflare Pages project from this repository.
4. Leave the build command blank.
5. Set the build output directory to `.`.
6. Add a D1 binding named `DB`.
7. Redeploy.

After the `DB` binding exists, the Functions use durable D1 storage automatically.
Without `DB`, deployed Functions return a configuration error on purpose so team data is not silently lost.

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

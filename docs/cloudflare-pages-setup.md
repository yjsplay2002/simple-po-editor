# Cloudflare Pages Setup

This project is designed to run on Cloudflare Pages with Pages Functions and a D1 binding named `DB`.

## Before you deploy

0. Authenticate Wrangler:
   - `npx wrangler login`
1. Create a D1 database in Cloudflare.
2. Open the SQL console for that database.
3. Run the contents of [`schema.sql`](../schema.sql) or [`migrations/0001_initial.sql`](../migrations/0001_initial.sql).

If you prefer the CLI, you can create the database from this repo after login:

```bash
npx wrangler d1 create simple-po-editor-db --binding DB --update-config
npx wrangler d1 execute simple-po-editor-db --remote --file=./schema.sql
```

## Create the Pages project

1. In Cloudflare, go to `Workers & Pages`.
2. Choose `Create application` -> `Pages` -> `Connect to Git`.
3. Select the GitHub repository `yjsplay2002/simple-po-editor`.
4. Use these build settings:
   - Build command: leave blank
   - Build output directory: `.`
   - Root directory: leave blank

`Build output directory = .` is the correct choice here because the deployed static files, including `index.html`, live in the repository root.

## Add the database binding

1. Open the Pages project.
2. Go to `Settings` -> `Bindings`.
3. Add a `D1 database` binding.
4. Set the variable name to `DB`.
5. Select the D1 database you created earlier.
6. Redeploy the project.

## Expected result

- The frontend is served by Cloudflare Pages.
- The API routes under `/api/*` run as Pages Functions.
- Document storage, locking, and versioning are persisted in D1.

## Important safety note

This app only allows in-memory storage during local development. If you deploy it without the `DB` binding, the API will return a storage configuration error instead of pretending to save team data.

## Optional CLI deploy flow

If you do not want to use Git integration yet, you can deploy directly after login:

```bash
npm run cf:deploy
```

For Pages-style local development:

```bash
npm run cf:dev
```

# Operations guide

Everything is live on the Neon project `po-desk` (organization DelMandir, US East N. Virginia, branch `main`). The site is published from `main` on GitHub by the included workflow.

`.env.local` and `admin-logins.txt` are git-ignored and exist only on the machine that set this up. Keep the logins in a password manager and delete the file. `.env.local` holds `AUTH_SECRET` and `RATE_LIMIT_SALT`, and can be recreated by generating new values and redeploying the function.

## Admin logins

Each department has one login, and `admin` is the super-admin. There is no email or self-service password reset.

Reset a password, which appends the new one to `admin-logins.txt`:

```bash
npm run admins -- capa
```

Sessions last 8 hours and end when the browser tab closes. Changing a password does not end a session that is already open; it can take up to 8 hours to expire.

To add a login, add it to the list in `scripts/admins.ts` and run `npm run admins`.

## Changing the backend

Apply database changes first, then deploy the function, then push the website.

```bash
npm run db:migrate
```

```bash
npx neon@latest deploy --env .env.local
```

## Backups

The Neon Free plan keeps 6 hours of history. Export the data regularly and keep exports private: never commit them to this public repository.

## Limits

The Free plan stops the database until the next billing period if it uses 100 compute hours or 5 GB of transfer in a month. Data is kept. Check usage in the Neon Console.

Submissions are limited to 30 an hour per address, status checks to 60, and sign-ins to 30 per address and 15 per username. Turnstile spam protection is optional: set `TURNSTILE_SECRET_KEY` on the function and `VITE_TURNSTILE_SITE_KEY` in `.env.production`, and add `https://challenges.cloudflare.com` to the Content Security Policy in `index.html`.

## Local verification

`npm test` runs the real migrations and API handler on PGlite, including department isolation. `.env.local` connects over HTTPS, because some networks block the direct Postgres port.

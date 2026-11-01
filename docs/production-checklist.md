# Operations guide

Everything is live on the Neon project `po-desk` (organization DelMandir, US East N. Virginia, branch `main`). The site is published from `main` on GitHub by the included workflow.

`.env.local` and `admin-logins.txt` are git-ignored and exist only on the machine that set this up. Keep the logins in a password manager and delete the file. `.env.local` holds `AUTH_SECRET` and `RATE_LIMIT_SALT`, and can be recreated by generating new values and redeploying the function.

## Admin logins

Each department has one login, and `admin` is the super-admin. Admins can change their own password under **Change password** on the dashboard. Doing so signs out their other sessions.

There is no email reset. If someone forgets a password, create a new one here, which appends it to `admin-logins.txt`:

```bash
npm run admins -- capa
```

Sessions last 8 hours and end when the browser tab closes.

To add a login, add it to the list in `scripts/admins.ts` and run `npm run admins`.

## Changing the backend

Apply database changes first, then deploy the function, then push the website.

```bash
npm run db:migrate
```

```bash
npx neon@latest deploy --env .env.local
```

## Telegram bot

The bot runs inside the same function. New requests go to the department's connected admins and the super-admin, with Accept and Deny buttons. Either button asks for a written reason, and the request does not change until the reason is sent. A reason lapses after 30 minutes. Requesters send their request code to the bot to follow it, and they see the status and the reason, not the request details.

To set it up:

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Add these to `.env.local`. Keep the token out of chat and out of git. The webhook secret can be any long random text, using only letters, numbers, `_` and `-`.

   ```
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_BOT_USERNAME=
   TELEGRAM_WEBHOOK_SECRET=
   TELEGRAM_API_URL=https://br-autumn-truth-b8telxln-api.compute.c-14.us-east-1.aws.neon.tech
   ```

3. Apply the database change, deploy the function, then connect Telegram to it.

   ```bash
   npm run db:migrate
   ```

   ```bash
   npx neon@latest deploy --env .env.local
   ```

   ```bash
   npm run telegram:setup
   ```

4. Create a one-time connection link for each admin. They are written to the git-ignored `telegram-links.txt` and last 3 days. Send each admin their own link, then delete the file.

   ```bash
   npm run telegram:links
   ```

   For one admin:

   ```bash
   npm run telegram:links -- capa
   ```

A department login can connect several Telegram accounts. Changing or resetting its password disconnects all of them, so they need new links. If Telegram is unavailable when a request arrives, the request is still saved, and `/pending` shows it.

## Backups

The Neon Free plan keeps 6 hours of history. Export the data regularly and keep exports private: never commit them to this public repository.

## Limits

The Free plan stops the database until the next billing period if it uses 100 compute hours or 5 GB of transfer in a month. Data is kept. Check usage in the Neon Console.

Submissions are limited to 30 an hour per address, status checks to 60, and sign-ins to 30 per address and 15 per username, and Telegram code attempts to 20 per chat. Turnstile spam protection is optional: set `TURNSTILE_SECRET_KEY` on the function and `VITE_TURNSTILE_SITE_KEY` in `.env.production`, and add `https://challenges.cloudflare.com` to the Content Security Policy in `index.html`.

## Local verification

`npm test` runs the real migrations and API handler on PGlite, including department isolation. `.env.local` connects over HTTPS, because some networks block the direct Postgres port.

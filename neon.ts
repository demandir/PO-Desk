import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  functions: {
    api: {
      name: "PO Desk API",
      source: "functions/api.ts",
      env: {
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS!,
        AUTH_SECRET: process.env.AUTH_SECRET!,
        RATE_LIMIT_SALT: process.env.RATE_LIMIT_SALT!,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
        TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME!,
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET!,
      },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});

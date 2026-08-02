# Geetmala Backend (Cloudflare Worker + Turso Database)

This folder contains the backend API for **Geetmala**, tracking favorites, play stats, and multi-device preferences.

---

## 1. Database Setup (Turso)

1. Create a free database on [Turso](https://turso.tech/):
   ```bash
   turso db create geetmala-qijubevadi --location aws-ap-south-1
   ```
2. Initialize the SQL schema using `schema.sql`:
   ```bash
   turso db shell geetmala-qijubevadi < schema.sql
   ```
   *(Or copy-paste `schema.sql` into the Turso web console SQL editor)*

3. Generate a database token:
   ```bash
   turso db tokens create geetmala-qijubevadi
   ```

---

## 2. Deploy to Cloudflare Workers

1. Set the Turso Auth Token secret in Cloudflare:
   ```bash
   npx wrangler secret put TURSO_AUTH_TOKEN
   # Paste the token generated from Turso above
   ```

2. Set the static API key secret:
   ```bash
   npx wrangler secret put API_KEY
   # Type a secret string matching API_KEY in geetmala/js/app.js (default: geetmala_secret_key_2026)
   ```

3. Deploy the worker:
   ```bash
   npx wrangler deploy
   ```

4. Copy your resulting worker URL (`https://geetmala-backend.<your-subdomain>.workers.dev`) and set `API_BASE` in `geetmala/js/app.js`:
   ```javascript
   API_BASE: 'https://geetmala-backend.<your-subdomain>.workers.dev',
   ```

# Portfolio Demo Frontend

This is a recruiter-facing, privacy-safe demonstration of Ahmed's WhatsApp Assistant. It is deliberately separate from the product's Version 1–3 code paths.

- The seed script creates only `portfolio-demo/data/portfolio-demo.db` with synthetic people, identifiers and conversations.
- The public runtime copies the existing analytics and follow-up readers unchanged into an isolated bundle.
- Its database adapter opens SQLite with `readonly: true` and `query_only = ON`.
- The runtime includes no WhatsApp adapter, AI client, credentials, production database or mutating business functions.

Run locally with `npm run demo:build` and then `npm run demo:start`.

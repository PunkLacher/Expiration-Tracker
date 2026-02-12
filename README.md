# License & Document Expiration Tracker

## Database seeding and runtime safety

This project uses:

- `backend/data.seed.db` (tracked in git): initial seed database for first deploy/start
- `backend/data.db` (ignored by git): runtime database used by the app

Backend startup behavior in `backend/server.js`:

1. If `backend/data.db` does not exist and `backend/data.seed.db` exists, seed is copied to runtime DB.
2. If `backend/data.db` already exists, it is **not** overwritten.

This allows:

- initial deploy to start with test/seed data
- subsequent deploys to preserve production data

Optional env override:

- `DB_SEED_FILE=/path/to/custom-seed.db`

## Local run

Backend:

```bash
cd backend
npm install
npm start
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

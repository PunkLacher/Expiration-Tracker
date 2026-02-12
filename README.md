# License & Document Expiration Tracker

## Database

Backend now uses PostgreSQL via `DATABASE_URL`.

On startup, the backend:

1. Creates required tables (`workspaces`, `items`) if they do not exist.
2. Ensures a default workspace exists.
3. Optionally imports `backend/data.json` once if documents table is empty.

For Render free-tier deployments, use a managed Postgres database (Render Postgres, Supabase, Neon, etc.) and set `DATABASE_URL` in backend environment variables.

## Recommended free hosting stack

- Frontend: Netlify
- Backend: Render free web service
- Database: Neon or Supabase free Postgres (set `DATABASE_URL`)
- Email: Brevo API (`BREVO_API_KEY`) instead of SMTP

Why Brevo API: Render free services commonly restrict outbound SMTP ports, while HTTPS API calls remain available.

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

# One

Standalone local build for `One`, the Hushh public-footprint self-audit product.

## Local Run

```bash
npm install
npm run dev -- --port 3000
```

Open [http://localhost:3000](http://localhost:3000).

The checked-in `.env.example` documents the real Firebase, Postgres, and RIA Personal Intelligence settings. The local `.env.local` in this workspace enables non-secret dev auth and mock personal-intelligence responses so the full UI can be verified without production secrets.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Database

The Prisma schema and initial PostgreSQL migration are in `prisma/`. Set `DATABASE_URL` to a local Postgres or Cloud SQL connection string, then run:

```bash
npm run db:generate
npm run db:migrate
```

# Deployment & Environments

Three environments, only one holds real data — same principle a professional team
uses to keep a student developer (or anyone) from needing production database access
just to keep the app running.

| | Dev | Staging | Production |
| --- | --- | --- | --- |
| Where | Your laptop | Render (2 services) | Render/host, owned by whoever runs the institution's deployment |
| Database | Local MongoDB | Its own Atlas cluster, synthetic data | Its own Atlas cluster, real data |
| Data | Synthetic (`npm run seed`) | Synthetic (same seed script) | Real |
| Who holds the DB credential | You | You | The institution — not the developer |
| Git branch | any local branch | `staging` | `main` |
| Deploys | — | auto, on every push to `staging` | auto, on every push to `main` |

## Branch → environment mapping

```
feature work → staging (branch) → main (branch)
                    ↓                    ↓
        Render staging services   production deployment
```

- **`main`** is the production branch. Only a production deployment should ever track
  it. Nothing reaches production except through a deliberate merge from `staging`.
- **`staging`** is where you do ongoing work and see it running live before promoting
  it. Both current Render services (API + client) track this branch.
- **Dev** never needs a branch of its own — it isn't deployed anywhere, it's just
  `npm run dev` against local MongoDB.

Promoting staging to production is a normal merge:
```bash
git checkout main
git merge staging
git push origin main
```

## Staging — current setup

Two Render services, both tracking the `staging` branch with auto-deploy on push:

| Service | Type | Root dir | URL |
| --- | --- | --- | --- |
| `sitare-university-system` | Web Service (Node) | `server` | https://sitare-university-system.onrender.com |
| `sitare-university-client` | Static Site | `client` | https://sitare-university-client.onrender.com |

Environment variables (set in each service's Render dashboard, never committed):

**API service**: `NODE_ENV=production`, `MONGO_URI` (staging Atlas cluster),
`JWT_SECRET` (a value generated for staging only — not shared with local dev or
production), `JWT_EXPIRES_IN`, `CLIENT_ORIGIN` (the client service's URL, for CORS
and Socket.io), `GOOGLE_CLIENT_ID`.

**Client service**: `VITE_API_URL` (the API service's URL — see below),
`VITE_GOOGLE_CLIENT_ID`.

### Why `VITE_API_URL` exists

Locally, Vite's dev proxy makes `/api` and `/socket.io` same-origin, so the client
never needs to know the API's address. Once client and API are two separately
hosted services (as on Render here), a relative `/api` call would hit the client's
own origin instead. `client/src/lib/api.js` exports `API_ORIGIN` from
`import.meta.env.VITE_API_URL`, used by every REST call and by the Socket.io
connection in `SocketContext.jsx`. Empty (`''`) is the default and means
same-origin — local dev is unaffected by this existing at all.

### Seeding a database that isn't local

`npm run seed` reads `MONGO_URI` from the environment exactly like the app does.
Override it for one command rather than editing `server/.env` back and forth:

```bash
# Git Bash / macOS / Linux
MONGO_URI="mongodb+srv://...staging-cluster.../sitare_erp_staging" node src/seed/seed.js
```
```powershell
# PowerShell
$env:MONGO_URI="mongodb+srv://...staging-cluster.../sitare_erp_staging"; node src/seed/seed.js
```

This works because `dotenv` (loading `server/.env`) never overrides a variable
already set in the shell, so your local `.env` — and local dev — is untouched.

### `seed.js` refuses to run against production

`seed.js` wipes every collection and creates the well-known `admin@sitare.org` /
`admin123` account — appropriate for dev/staging, never for a real deployment.
It checks `NODE_ENV` and exits immediately with an error if it is `production`,
rather than relying on everyone remembering not to run it there. This is why a
production deployment should always have `NODE_ENV=production` set (it already
needs to be, for other reasons — see the API service's env vars) — that same
setting is what makes this guard effective. Bootstrapping a real admin account
uses `create-admin.mjs` instead (see below), which never deletes anything.

### A note on the MongoDB Atlas IP allowlist

Render's free tier doesn't offer a fixed outbound IP, so the staging Atlas cluster's
Network Access list allows `0.0.0.0/0` (anywhere). That's an acceptable tradeoff for
a cluster that only ever holds synthetic data. **Production must not do this** — its
allowlist should be scoped to the actual hosting platform's real IP range (or a
paid static-IP add-on), configured by whoever controls production, not by a
developer working from their own laptop.

## Production — intended setup (not this developer's to configure)

Production should be a separate Atlas cluster and a separate deployment, both
created and held by the institution (or whoever officially owns the deployment) —
not by the student developer. The developer's ongoing access should be limited to:

- Pushing code to `staging`, and opening the `staging` → `main` merge.
- Reading deploy/build logs, for debugging.
- **Never** the production database credential, and never the production `JWT_SECRET`.

Handoff mechanics that make this actually true, not just a policy:
- The production Atlas project should not list the developer as a member (or only
  with a role that can't view connection strings).
- Production secrets are pasted into the hosting platform's environment-variable
  panel by whoever owns production — most platforms (Render included) mask a saved
  env var afterward; nobody can read it back through the UI, only overwrite it.
- On handoff, rotate the production DB password and `JWT_SECRET`. Anything the
  developer may have seen during earlier testing stops working immediately.

### Bootstrapping the first production admin

A freshly created production database has zero users, and every account in this
app is normally created by an existing admin through Admin → People — so nobody
can log in at all until one admin exists. Whoever holds production runs, once:

```bash
MONGO_URI="the-production-connection-string" node create-admin.mjs "Real Name" "real-email@sitare.org" "a-real-password-they-choose"
```

This is the only sanctioned way to get a first admin into production. It never
deletes anything and refuses if the email already exists, so it's safe even if
run twice by accident — unlike `seed.js`, which must never touch this database
and now refuses outright if `NODE_ENV=production` (see above).

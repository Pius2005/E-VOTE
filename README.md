# SUG VOTE

**Your Vote. Your Voice. Your Future.**

A Student Union Government electronic voting platform: Node.js/Express backend, Prisma + PostgreSQL, deployable on Vercel, with email OTP, WebAuthn/passkey, and browser-based camera liveness as layered voter authentication, plus an anonymous-ballot architecture that separates *who voted* from *what they voted for*.

---

## 1. Local setup

```bash
npm ci
cp .env.example .env
# edit .env — see "Environment variables" below
npx prisma generate
npx prisma migrate deploy
npm run seed        # optional — creates sample admin/students/election
npm run dev          # http://localhost:3000


node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#using docker for database
docker run --name evote-db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sug_vote -p 5432:5432 -d postgres

#for codespaces
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres psql -c "CREATE DATABASE sug_vote;"
```

Node.js 20.9 or newer is required.

Seeded logins (only if you ran `npm run seed`):
- Admin: `ADMIN/0001` / `AdminPass!2025`
- Electoral Officer: `EO/0001` / `OfficerPass!2025`
- Student: `CSC/20/0001` / `Passw0rd!23`

**Change these before any real use, or skip seeding entirely for production** — the app runs correctly against an empty database.

### Role behavior in the app

- `ADMIN` and `ELECTION_OFFICER` users are routed to the admin dashboard after login.
- `STUDENT` users are routed to the voter flow, which includes OTP verification during voting.
- Staff accounts intentionally do not go through the student voting OTP process.

## 2. Environment variables

See `.env.example` for the full list with descriptions. At minimum for local dev:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon, Supabase, etc.) |
| `SESSION_SECRET` | Signs session JWTs — `openssl rand -hex 32` |
| `OTP_PEPPER` | HMACs stored OTP hashes — `openssl rand -hex 32` |
| `RESEND_API_KEY` | Leave blank in dev to log OTP emails to the console instead of sending |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Must match your actual domain in production |

## 3. Deploying to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel.
3. Set all variables from `.env.example` in the Vercel project settings (use your real domain for `APP_URL`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`).
4. Point `DATABASE_URL` at a Vercel-compatible Postgres provider (Neon or Supabase both work well).
5. Deploy. `api/index.js` exports the Express app for Vercel's serverless runtime — it never calls `app.listen()`. `server.js` is the separate local-dev entry point that does.
6. After first deploy, run `npx prisma migrate deploy` against the production `DATABASE_URL` (from your machine or a one-off script) to create tables.

## 4. Architecture notes

- **Anonymity:** `VoterParticipation` records *that* a student voted (student ID + election ID, unique constraint prevents double voting). `Ballot`/`BallotSelection` record *what* was voted for, with no link back to the voter. An admin can query participation but never selections.
- **Vote submission is one atomic transaction** (`src/services/vote.service.js`): re-validates election status, eligibility, session verification, and candidate/position integrity, then writes participation + ballot + selections + session completion together. Any failure rolls back everything — no partial votes.
- **Double-vote prevention** is enforced at the database level via a `@@unique([studentId, electionId])` constraint on `VoterParticipation`, not just application logic — this holds up under concurrent requests.
- **OTP codes** are never stored in plaintext, only an HMAC hash; max 3 attempts, 5-minute expiry, resend cooldown, and old codes are invalidated when a new one issues. Voting OTPs are bound to one student and one voting session; admin/election-officer staff logins bypass this flow by redirecting to the admin dashboard instead.
- **Camera liveness** runs entirely client-side with self-hosted models. The server chooses an expiring, single-use challenge and stores only the completed action; no frames leave the device. Browser-only liveness deters basic spoofing but is not equivalent to specialist biometric anti-spoofing.
- **Candidate images** are decoded, resized, metadata-stripped, converted to JPEG, and stored in PostgreSQL so they survive Vercel serverless restarts. Existing filesystem photo URLs remain readable for compatibility.
- **Candidate profile fields** are supported as optional metadata for election administration: `statement`, `candidateInfo`, `level`, `course`, plus display order and optional photo. These fields are stored in the `Candidate` record and can be left blank when not needed.
- **Results stay hidden** from election officers while an election is `ACTIVE`/`PAUSED` — only turnout-level metrics are exposed until the election is `CLOSED`, to avoid influencing ongoing voting.

## 5. What's implemented vs. what's a first pass

Implemented and working end to end: auth (password + OTP + WebAuthn with a persistent DB-backed challenge store), role-based routing for admin/election-officer staff versus student voting flow, real client-side face liveness detection (self-hosted face-api.js, blink/smile/head-turn challenges), eligibility checking, the full ballot → review → atomic submit flow, CSRF protection, boot-time environment validation, role-gated live results (ADMIN-only, audit-logged), real image upload validation/re-encoding, candidate disqualification workflow, optional candidate profile metadata (statement, info, level, course, photo), position creation from the admin dashboard, notifications, admin settings, admin dashboard charts, an audit log + security alerts viewer, CSV voter import/export, results with vote tallies, and PPTX report export.

Reasonable first-pass, worth hardening further before a real election:
- **Liveness detection thresholds** (`public/js/liveness.js`) — the EAR/smile/yaw thresholds are reasonable defaults but haven't been tuned against real device/lighting variety; expect to adjust `EAR_BLINK_THRESHOLD`, `MOUTH_SMILE_RATIO`, and `YAW_TURN_THRESHOLD` after testing on actual student devices.
- **Notifications are in-app only** — no email/SMS delivery for notifications yet (OTP and password reset emails work; election status notifications are currently database records surfaced via the bell icon only).
- **Settings are minimal** — a small admin-editable allowlist (site name, support email, office contact); no "maintenance mode" enforcement wired into the app yet even though the key exists.
- **Candidate metadata is optional, not a blocking requirement** — the admin form accepts blank values, allowing a lightweight candidate list when not all details are available.
- **Test coverage** includes unit/security checks plus PostgreSQL-backed vote transaction tests in CI, including concurrent double-vote prevention and malformed ballots.
- **Upstream PPTX advisory:** `pptxgenjs` currently depends on an `image-size` release with high-severity advisories and no patched upstream version. The report route is authenticated and never parses images, so the vulnerable parsers are unreachable in this application; continue monitoring for an upstream fix.

None of this is placeholder/TODO code — everything listed above executes for real, it's the polish/scale layer that's incomplete.

## 6. Project structure

```
SUG-VOTE/
├── api/index.js          # Vercel serverless entry (exports Express app)
├── server.js              # Local dev entry (app.listen)
├── src/
│   ├── app.js              # Express app assembly
│   ├── lib/                # prisma client, env config
│   ├── middleware/         # auth, RBAC, rate limiting
│   ├── routes/              # auth, vote, election, candidate, voter, result, report
│   └── services/            # password, OTP, session, WebAuthn, vote transaction, audit, email
├── prisma/schema.prisma
├── public/                 # static frontend (HTML/CSS/vanilla JS)
├── scripts/seed.js         # dev-only, safe to delete
├── tests/
├── vercel.json
└── .env.example
```

## 7. Running tests

```bash
npm test
```

# CLAUDE.md — PSX Dividend Calculator

## Project overview

A personal web app to track PSX (Pakistan Stock Exchange) stock holdings and calculate dividend income with withholding tax. Single-user, API-key-gated, deployed on Vercel with a Supabase PostgreSQL database.

## Stack

- **Backend**: Python 3.10+, FastAPI, uvicorn, psycopg2-binary (Supabase)
- **Frontend**: Vanilla HTML/CSS/JS (no framework), Inter font, dark/light theme toggle
- **Database**: Supabase PostgreSQL — single `holdings` table
- **Scraping**: `requests` + `beautifulsoup4` — live dividend data from `dps.psx.com.pk`
- **Auth**: Single API key via `X-API-Key` header, compared with `secrets.compare_digest`
- **Rate limiting**: `slowapi` — 10 req/min (calculate), 30/min (writes), 60/min (reads)
- **Deployment**: Vercel (`vercel.json` + `requirements.txt`)

## Local setup

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
# create .env (see below)
venv/bin/uvicorn server:app --reload --port 5000
```

Open `http://localhost:5000`.

## Environment variables

Create a `.env` file (gitignored):

```
SUPABASE_URI=postgresql://postgres.[ref]:[password]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres
API_KEY=<generate with: python3 -c "import secrets; print(secrets.token_urlsafe(32))">
```

Use the **Connection Pooler** URI from Supabase → Settings → Database (not the direct host — IPv6 issues).

On Vercel, set both as environment variables under Project → Settings → Environment Variables.

## Key files

| File | Purpose |
|------|---------|
| `server.py` | FastAPI app — all API routes, DB ops, PSX scraper, dividend calculation |
| `static/index.html` | Single-page app shell — 3 views (Portfolio, History, Calculate) + modal |
| `static/app.js` | All frontend logic — gate auth, nav, portfolio/history render, calculate, theme toggle |
| `static/style.css` | Dark/light theme via CSS custom properties (`[data-theme="light"]` override) |
| `pencil-new.pen` | Pencil design file — all 4 screens (Login Gate, Portfolio, History, Calculate) |
| `vercel.json` | Routes everything to `server.py` via `@vercel/python` |
| `requirements.txt` | Python dependencies (pinned) |
| `dividend_calc.py` | CLI alternative — uses `rich` for terminal output |

## Database schema

```sql
CREATE TABLE holdings (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT    NOT NULL CHECK (symbol ~ '^[A-Z0-9]{1,8}$'),
  shares        INTEGER NOT NULL CHECK (shares > 0),
  purchase_date DATE    NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

Row Level Security is enabled in Supabase.

## API routes

| Method | Path | Rate limit | Description |
|--------|------|-----------|-------------|
| GET | `/api/portfolio` | 60/min | List all holdings |
| POST | `/api/portfolio` | 30/min | Add single holding |
| POST | `/api/portfolio/bulk` | 20/min | Add up to 50 holdings |
| DELETE | `/api/portfolio/{id}` | 30/min | Delete by DB id |
| POST | `/api/calculate` | 10/min | Calculate dividends |

FastAPI docs (`/docs`, `/redoc`, `/openapi.json`) are **disabled** in production.

## Dividend calculation

```
Gross = shares × (cash_pct / 100) × 10      # face value PKR 10
WHT   = Gross × tax_rate
Net   = Gross − WHT
```

Tax rates: filer 15%, non-filer 30%.

A dividend is counted only if its ex-date is **on or after** the purchase date and within the selected period.

## Frontend theme

Theme is toggled via a button in the sidebar. `data-theme="light"` is set on `<html>`. Preference is saved to `localStorage` under key `psx_theme`. Default is dark.

## Important conventions

- **Always update README.md** when features, API, or setup instructions change.
- **Never commit `.env`** — it's gitignored.
- **DB errors are not leaked** to the client — only generic `"Database error"` is returned.
- **Symbols are validated** as `^[A-Z0-9]{1,8}$` both in Pydantic and in DB CHECK constraint.
- Delete uses the DB `id` field, not array index.
- Bulk insert is a single transaction — all-or-nothing.
- The PSX scraper POSTs to `https://dps.psx.com.pk/company/payouts` with `Referer` and `X-Requested-With: XMLHttpRequest` headers required.

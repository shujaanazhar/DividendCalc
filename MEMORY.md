# Project Memory — PSX Dividend Calculator

## What this app does
Personal web app to track PSX stock holdings and calculate dividend income with withholding tax (filer 15%, non-filer 30%). Single-user, API-key gated.

## Key decisions made
- **No calculation storage** — results are always computed live from PSX; no point caching stale data
- **API key auth over login/signup** — solo-use app, simpler and more secure for personal finance
- **Supabase Connection Pooler URI** — direct db.xxx host has IPv6 issues on Vercel
- **Face value assumed PKR 10** — a small number of PSX companies use PKR 5 or PKR 1 which will give wrong results
- **Only cash dividends counted** — bonus shares detected but excluded from PKR totals
- **Dark mode default** — matches the Pencil design; light mode available via sidebar toggle

## Stack
- Backend: FastAPI + psycopg2 → Supabase PostgreSQL
- Frontend: Vanilla HTML/CSS/JS, no framework
- Scraping: POST to `https://dps.psx.com.pk/company/payouts` (needs `Referer` + `X-Requested-With: XMLHttpRequest` headers)
- Deploy: Vercel (`@vercel/python`), env vars `API_KEY` + `SUPABASE_URI`

## Files
| File | Purpose |
|------|---------|
| `server.py` | All API routes, DB ops, PSX scraper, dividend calc |
| `static/index.html` | SPA shell — Portfolio, History, Calculate views + modals |
| `static/app.js` | All frontend logic |
| `static/style.css` | Dark/light theme via CSS custom properties |
| `pencil-new.pen` | Pencil design file — all 4 screens |
| `vercel.json` | Vercel routing config |
| `requirements.txt` | Pinned Python deps |
| `dividend_calc.py` | CLI alternative using `rich` |
| `CLAUDE.md` | Instructions for Claude Code |
| `.gitignore` | Excludes `.env`, `venv/`, `portfolio.json` |

## API routes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolio` | List all holdings |
| POST | `/api/portfolio` | Add single holding |
| POST | `/api/portfolio/bulk` | Add up to 50 holdings |
| PUT | `/api/portfolio/{id}` | Edit a holding (symbol, shares, date) |
| DELETE | `/api/portfolio/{id}` | Delete a holding |
| POST | `/api/calculate` | Calculate dividends |

## DB schema
```sql
CREATE TABLE holdings (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT    NOT NULL CHECK (symbol ~ '^[A-Z0-9]{1,8}$'),
  shares        INTEGER NOT NULL CHECK (shares > 0),
  purchase_date DATE    NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

## Known limitations
- PSX portal only returns ~5 most recent dividends per company
- Face value assumed PKR 10 for all symbols
- No mobile sidebar — replaced with bottom nav bar on screens ≤680px

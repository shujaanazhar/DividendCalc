# PSX Dividend Calculator

A web app to track and calculate cash dividends received on your Pakistan Stock Exchange (PSX) holdings, with withholding tax (WHT) applied based on your filer status.

## Features

- Add multiple holdings at once — enter as many stocks as you want in a single modal and save them all in one click
- Live dividend data fetched from the PSX data portal (`dps.psx.com.pk`)
- Dividends only counted if the ex-date falls on or after your purchase date
- Withholding tax calculation — filer (15%) or non-filer (20%)
- Shows gross amount, WHT deducted, and net received per dividend and per holding
- Filter by period:
  - All time
  - Year to Date (YTD)
  - Current month
  - Specific year
  - Custom date range
- Portfolio persisted locally in `portfolio.json`

## Deployment (Vercel + Supabase)

### 1. Create the Supabase table

In your Supabase project → SQL Editor:

```sql
create table holdings (
  id            serial primary key,
  symbol        text    not null,
  shares        integer not null,
  purchase_date date    not null,
  created_at    timestamptz default now()
);
```

### 2. Set environment variables

Locally, create a `.env` file:

```
SUPABASE_URI=postgresql://postgres:[password]@[host]:5432/postgres
API_KEY=your-strong-random-key
```

Use the **Connection Pooler** URI from Supabase → Settings → Database (recommended for serverless).

Generate a secure API key:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

On Vercel, add both `SUPABASE_URI` and `API_KEY` under Project → Settings → Environment Variables.

### 3. Deploy

```bash
npm i -g vercel   # if not installed
vercel            # follow prompts
```

Vercel picks up `vercel.json` and `requirements.txt` automatically.

---

## Requirements

- Python 3.10+
- Internet connection (fetches live data from PSX)

## Setup

```bash
# Create virtual environment
python3 -m venv venv

# Install dependencies
venv/bin/pip install fastapi uvicorn requests beautifulsoup4
```

## Running the web app

```bash
venv/bin/uvicorn server:app --reload --port 5000
```

Then open `http://localhost:5000` in your browser.

The app has three views accessible from the sidebar:

- **Portfolio** — stocks grouped by symbol showing total shares per company, with individual purchase lots listed under each
- **History** — every individual purchase entry sorted oldest first, with the ability to delete individual lots
- **Calculate** — select a period and tax status, then fetch live PSX data and compute your dividends

## Running the CLI (alternative)

```bash
venv/bin/pip install rich
venv/bin/python dividend_calc.py
```

## How dividends are calculated

PSX companies declare dividends as a percentage of face value. The standard face value for most PSX-listed shares is **PKR 10**.

```
Gross  = Shares × (Dividend % / 100) × PKR 10
WHT    = Gross × Tax Rate
Net    = Gross − WHT
```

**Example:** 1,000 shares of HBL with a 50% cash dividend, filer status:

```
Gross = 1,000 × 0.50 × 10 = PKR 5,000
WHT   = 5,000 × 15%        = PKR   750
Net   =                      PKR 4,250
```

A dividend is included in results only if:
1. The ex-date is on or after your purchase date
2. The ex-date falls within the selected period

## Withholding tax rates

| Status     | Rate |
|------------|------|
| Filer      | 15%  |
| Non-Filer  | 30%  |

Tax is deducted at source by the company before the dividend is credited to your account. The app shows both the gross amount and the net amount you actually receive.

## API endpoints

The FastAPI server exposes the following endpoints. Interactive docs available at `http://localhost:5000/docs`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/portfolio` | List all holdings |
| `POST` | `/api/portfolio` | Add a single holding |
| `POST` | `/api/portfolio/bulk` | Add multiple holdings in one request (max 50) |
| `DELETE` | `/api/portfolio/{idx}` | Remove a holding by index |
| `POST` | `/api/calculate` | Calculate dividends |

### POST `/api/calculate` body

```json
{
  "period": "ytd",
  "tax_status": "filer",
  "year": 2025,
  "from_date": "2024-01-01",
  "to_date": "2024-12-31"
}
```

- `period`: `"all"` | `"ytd"` | `"month"` | `"year"` | `"custom"`
- `tax_status`: `"filer"` | `"non_filer"` (default: `"filer"`)
- `year`: required when `period` is `"year"`
- `from_date` / `to_date`: required when `period` is `"custom"`

## Portfolio file

Holdings are saved to `portfolio.json` in the project directory. You can edit it directly if needed:

```json
[
  {
    "symbol": "HBL",
    "shares": 1000,
    "purchase_date": "2023-01-01"
  },
  {
    "symbol": "LUCK",
    "shares": 500,
    "purchase_date": "2022-06-01"
  }
]
```

## Data source

Dividend history is fetched live from the [PSX Data Portal](https://dps.psx.com.pk). The portal shows the last ~5 dividend announcements per company. Older history may not be available without a paid data source.

## Security

- **API key auth** — every API request requires `X-API-Key` header. The browser prompts for the key on first visit and stores it in `localStorage`. A wrong/missing key returns 401.
- **Rate limiting** — calculate is capped at 10 req/min, portfolio reads at 60/min, writes at 30/min.
- **Input validation** — symbols validated as 1–8 alphanumeric chars, shares bounded to 10M, dates cannot be future or pre-1990, period/tax_status are whitelisted enums.
- **DB constraints** — `CHECK` constraints on the `holdings` table mirror app-level validation as a second layer.
- **SSL enforced** — `sslmode=require` appended to the DB connection string.
- **Row Level Security** — enabled on the `holdings` table in Supabase.
- **FastAPI docs disabled** — `/docs`, `/redoc`, and `/openapi.json` are all turned off in production.
- **DB errors not leaked** — internal psycopg2 errors are logged server-side only; client receives a generic `"Database error"` message.
- **`.env` gitignored** — credentials never committed to version control.

## Limitations

- Only **cash dividends** are counted. Bonus shares are detected and displayed but excluded from PKR calculations.
- PSX portal data goes back ~5 records per company.
- Face value is assumed to be PKR 10 for all symbols. A small number of companies use PKR 5 or PKR 1 face value — results for those will be inaccurate.

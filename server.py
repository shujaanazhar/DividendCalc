#!/usr/bin/env python3
"""PSX Dividend Calculator — FastAPI server"""

import logging
import os
import re
import secrets
from contextlib import contextmanager
from datetime import date, datetime
from typing import Optional

from datetime import timedelta

import psycopg2
import psycopg2.extras
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

load_dotenv()

log = logging.getLogger("uvicorn.error")

PSX_PAYOUT_URL = "https://dps.psx.com.pk/company/payouts"
FACE_VALUE     = 10.0
TAX_RATES      = {"filer": 0.15, "non_filer": 0.30}
HEADERS        = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
}

# Valid PSX symbol: 1–8 uppercase letters/digits only
SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,8}$")

# ── App setup ─────────────────────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(
    title="PSX Dividend Calculator",
    docs_url=None,      # disable /docs
    redoc_url=None,     # disable /redoc
    openapi_url=None,   # disable /openapi.json
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Only allow requests from same origin (browser enforced)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten to your Vercel domain after deploy
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["X-API-Key", "Content-Type"],
)

# ── Auth ──────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("API_KEY", "").strip()
if not API_KEY:
    raise RuntimeError("API_KEY environment variable not set")

def verify_api_key(request: Request):
    key = request.headers.get("X-API-Key", "")
    if not secrets.compare_digest(key, API_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Database ──────────────────────────────────────────────────────────────────

def get_db_uri() -> str:
    uri = os.environ.get("SUPABASE_URI", "").strip()
    if not uri:
        raise RuntimeError("SUPABASE_URI environment variable not set")
    # Enforce SSL
    if "sslmode" not in uri:
        uri += "?sslmode=require"
    return uri

@contextmanager
def get_conn():
    conn = psycopg2.connect(get_db_uri())
    try:
        yield conn
        conn.commit()
    except psycopg2.Error as e:
        conn.rollback()
        log.error("DB error: %s", e)
        raise HTTPException(status_code=500, detail="Database error")
    finally:
        conn.close()

def init_db():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS holdings (
                    id            SERIAL PRIMARY KEY,
                    symbol        TEXT    NOT NULL CHECK (symbol ~ '^[A-Z0-9]{1,8}$'),
                    shares        INTEGER NOT NULL CHECK (shares > 0),
                    purchase_date DATE    NOT NULL,
                    created_at    TIMESTAMPTZ DEFAULT now()
                )
            """)

@app.on_event("startup")
def startup():
    init_db()


# ── Models ────────────────────────────────────────────────────────────────────

class Holding(BaseModel):
    symbol: str
    shares: int
    purchase_date: str

    @field_validator("symbol")
    @classmethod
    def valid_symbol(cls, v):
        v = v.upper().strip()
        if not SYMBOL_RE.match(v):
            raise ValueError("Invalid symbol — must be 1–8 alphanumeric characters")
        return v

    @field_validator("shares")
    @classmethod
    def positive_shares(cls, v):
        if v <= 0 or v > 10_000_000:
            raise ValueError("shares must be between 1 and 10,000,000")
        return v

    @field_validator("purchase_date")
    @classmethod
    def valid_date(cls, v):
        d = date.fromisoformat(v)
        if d > date.today():
            raise ValueError("purchase_date cannot be in the future")
        if d.year < 1990:
            raise ValueError("purchase_date too far in the past")
        return v


class CalcRequest(BaseModel):
    period: str = "all"
    year: Optional[int] = None
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    tax_status: str = "filer"

    @field_validator("period")
    @classmethod
    def valid_period(cls, v):
        if v not in {"all", "ytd", "month", "year", "custom"}:
            raise ValueError("invalid period")
        return v

    @field_validator("tax_status")
    @classmethod
    def valid_tax_status(cls, v):
        if v not in TAX_RATES:
            raise ValueError("tax_status must be filer or non_filer")
        return v

    @field_validator("year")
    @classmethod
    def valid_year(cls, v):
        if v is not None and not (1990 <= v <= date.today().year):
            raise ValueError("invalid year")
        return v


# ── Portfolio DB ops ──────────────────────────────────────────────────────────

def db_list_holdings() -> list:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, symbol, shares, purchase_date::text FROM holdings ORDER BY created_at"
            )
            return [dict(r) for r in cur.fetchall()]


def db_add_holding(symbol: str, shares: int, purchase_date: str) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO holdings (symbol, shares, purchase_date)
                   VALUES (%s, %s, %s)
                   RETURNING id, symbol, shares, purchase_date::text""",
                (symbol, shares, purchase_date),
            )
            return dict(cur.fetchone())


def db_add_holdings_bulk(holdings: list) -> list:
    """Insert multiple holdings in a single transaction."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            results = []
            for h in holdings:
                cur.execute(
                    """INSERT INTO holdings (symbol, shares, purchase_date)
                       VALUES (%s, %s, %s)
                       RETURNING id, symbol, shares, purchase_date::text""",
                    (h.symbol, h.shares, h.purchase_date),
                )
                results.append(dict(cur.fetchone()))
            return results


def db_delete_holding(holding_id: int) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM holdings WHERE id = %s", (holding_id,))
            return cur.rowcount > 0


def db_update_holding(holding_id: int, symbol: str, shares: int, purchase_date: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE holdings SET symbol=%s, shares=%s, purchase_date=%s
                   WHERE id=%s
                   RETURNING id, symbol, shares, purchase_date::text""",
                (symbol, shares, purchase_date, holding_id),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ── PSX scraper ───────────────────────────────────────────────────────────────

def fetch_dividends(symbol: str) -> list:
    """Fetch dividend history for a validated PSX symbol."""
    if not SYMBOL_RE.match(symbol):
        return []
    try:
        resp = requests.post(
            PSX_PAYOUT_URL,
            data={"symbol": symbol},
            headers={**HEADERS, "Referer": f"https://dps.psx.com.pk/company/{symbol}"},
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        log.warning("PSX fetch failed for %s: %s", symbol, e)
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    dividends = []

    for row in soup.select("tbody.tbl__body tr"):
        cols = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cols) < 4:
            continue

        ann_date_str, period, details, book_closure = cols[0], cols[1], cols[2], cols[3]

        try:
            parts = ann_date_str.split(" ")
            ann_date = datetime.strptime(f"{parts[0]} {parts[1]} {parts[2]}", "%B %d, %Y").date()
        except Exception:
            continue

        cash_pct = bonus_pct = 0.0
        for pct_str, dtype in re.findall(r"([\d.]+)%\([^)]*\)\s*\(([DB])\)", details):
            if dtype == "D":
                cash_pct += float(pct_str)
            elif dtype == "B":
                bonus_pct += float(pct_str)

        # Parse book closure: "23/03/2026  - 30/03/2026"
        # ex_date = day before book closure start (eligibility cutoff)
        # payment_date = book closure end + ~15 days (when money actually arrives)
        # We use book closure END for period filtering since that's closest to payment.
        ex_date      = ann_date  # fallback
        payment_date = ann_date  # fallback
        bc_str = book_closure.replace("\xa0", " ").strip()
        bc_parts = [p.strip() for p in bc_str.split("-") if p.strip()]
        if bc_parts:
            try:
                bc_start = datetime.strptime(bc_parts[0].strip(), "%d/%m/%Y").date()
                ex_date  = bc_start  # day before bc_start is true ex-date, bc_start ≈ good enough
            except Exception:
                pass
            if len(bc_parts) >= 2:
                try:
                    bc_end       = datetime.strptime(bc_parts[1].strip(), "%d/%m/%Y").date()
                    # CDC typically credits ~15 days after book closure ends
                    payment_date = bc_end + timedelta(days=15)
                except Exception:
                    payment_date = ex_date

        dividends.append({
            "announcement_date": ann_date.isoformat(),
            "ex_date":           ex_date.isoformat(),
            "payment_date":      payment_date.isoformat(),
            "period":            period,
            "cash_pct":          cash_pct,
            "bonus_pct":         bonus_pct,
            "details":           details,
        })

    return dividends


# ── Calculation ───────────────────────────────────────────────────────────────

def calculate(holdings: list, dividends_by_symbol: dict,
              from_date: Optional[date], to_date: Optional[date],
              tax_rate: float = 0.15) -> dict:
    results = []
    grand_gross = grand_tax = 0.0

    for h in holdings:
        symbol        = h["symbol"]
        shares        = h["shares"]
        purchase_date = date.fromisoformat(h["purchase_date"])
        holding_gross = 0.0
        events        = []

        for div in dividends_by_symbol.get(symbol, []):
            ex_date      = date.fromisoformat(div["ex_date"])
            payment_date = date.fromisoformat(div.get("payment_date", div["ex_date"]))
            # Must have held the stock before ex-date to be eligible
            if ex_date < purchase_date:
                continue
            # Period filter uses payment_date — when money actually arrives
            if from_date and payment_date < from_date:
                continue
            if to_date and payment_date > to_date:
                continue
            if div["cash_pct"] == 0:
                continue

            gross = shares * (div["cash_pct"] / 100.0) * FACE_VALUE
            tax   = gross * tax_rate
            holding_gross += gross
            events.append({
                "ex_date":      div["ex_date"],
                "payment_date": div.get("payment_date", div["ex_date"]),
                "period":    div["period"],
                "cash_pct":  div["cash_pct"],
                "bonus_pct": div["bonus_pct"],
                "details":   div["details"],
                "gross":     round(gross, 2),
                "tax":       round(tax, 2),
                "net":       round(gross - tax, 2),
            })

        holding_tax = round(holding_gross * tax_rate, 2)
        grand_gross += holding_gross
        grand_tax   += holding_tax
        results.append({
            "symbol":        symbol,
            "shares":        shares,
            "purchase_date": h["purchase_date"],
            "gross":         round(holding_gross, 2),
            "tax":           holding_tax,
            "net":           round(holding_gross - holding_tax, 2),
            "events":        sorted(events, key=lambda x: x["ex_date"]),
        })

    grand_gross = round(grand_gross, 2)
    grand_tax   = round(grand_tax, 2)
    return {
        "holdings":    results,
        "grand_gross": grand_gross,
        "grand_tax":   grand_tax,
        "grand_net":   round(grand_gross - grand_tax, 2),
    }


# ── API routes ────────────────────────────────────────────────────────────────

auth = Depends(verify_api_key)

@app.get("/api/portfolio", dependencies=[auth])
@limiter.limit("60/minute")
def get_portfolio(request: Request):
    return db_list_holdings()


@app.post("/api/portfolio", status_code=201, dependencies=[auth])
@limiter.limit("30/minute")
def add_holding(request: Request, holding: Holding):
    return db_add_holding(holding.symbol, holding.shares, holding.purchase_date)


@app.post("/api/portfolio/bulk", status_code=201, dependencies=[auth])
@limiter.limit("20/minute")
def add_holdings_bulk(request: Request, holdings: list[Holding]):
    if not holdings:
        raise HTTPException(400, "No holdings provided")
    if len(holdings) > 50:
        raise HTTPException(400, "Maximum 50 holdings per batch")
    return db_add_holdings_bulk(holdings)


@app.put("/api/portfolio/{holding_id}", dependencies=[auth])
@limiter.limit("30/minute")
def update_holding(request: Request, holding_id: int, holding: Holding):
    if holding_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid ID")
    row = db_update_holding(holding_id, holding.symbol, holding.shares, holding.purchase_date)
    if not row:
        raise HTTPException(status_code=404, detail="Holding not found")
    return row


@app.delete("/api/portfolio/{holding_id}", dependencies=[auth])
@limiter.limit("30/minute")
def delete_holding(request: Request, holding_id: int):
    if holding_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid ID")
    if not db_delete_holding(holding_id):
        raise HTTPException(status_code=404, detail="Holding not found")
    return {"ok": True}


@app.post("/api/calculate", dependencies=[auth])
@limiter.limit("10/minute")
def calculate_route(request: Request, req: CalcRequest):
    today = date.today()

    if req.period == "all":
        from_date, to_date, label = None, None, "All Time"
    elif req.period == "ytd":
        from_date = date(today.year, 1, 1)
        to_date   = date(today.year, 12, 31)   # full year — include near-future payments
        label     = f"Year to Date ({today.year})"
    elif req.period == "month":
        import calendar
        last_day  = calendar.monthrange(today.year, today.month)[1]
        from_date = date(today.year, today.month, 1)
        to_date   = date(today.year, today.month, last_day)  # full month
        label     = today.strftime("%B %Y")
    elif req.period == "year":
        year      = req.year or today.year
        from_date = date(year, 1, 1)
        to_date   = date(year, 12, 31)
        label     = f"Full Year {year}"
    elif req.period == "custom":
        if not req.from_date or not req.to_date:
            raise HTTPException(400, "from_date and to_date required")
        try:
            from_date = date.fromisoformat(req.from_date)
            to_date   = date.fromisoformat(req.to_date)
        except ValueError:
            raise HTTPException(400, "Invalid date format")
        if from_date > to_date:
            raise HTTPException(400, "from_date must be before to_date")
        label = f"{from_date} → {to_date}"

    tax_rate  = TAX_RATES[req.tax_status]
    portfolio = db_list_holdings()
    if not portfolio:
        raise HTTPException(400, "Portfolio is empty")

    symbols             = list({h["symbol"] for h in portfolio})
    dividends_by_symbol = {sym: fetch_dividends(sym) for sym in symbols}

    result = calculate(portfolio, dividends_by_symbol, from_date, to_date, tax_rate)
    result["label"]        = label
    result["tax_status"]   = req.tax_status
    result["tax_rate_pct"] = int(tax_rate * 100)
    return result


# ── Serve frontend ────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse("static/index.html")

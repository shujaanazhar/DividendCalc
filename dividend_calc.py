#!/usr/bin/env python3
"""
PSX Dividend Calculator
Calculate dividends received on your PSX holdings.
"""

import json
import os
import sys
from datetime import date, datetime
from typing import Optional

import requests
from bs4 import BeautifulSoup
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table
from rich import box

PORTFOLIO_FILE = "portfolio.json"
PSX_PAYOUT_URL = "https://dps.psx.com.pk/company/payouts"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
}

console = Console()


# ─── Portfolio helpers ────────────────────────────────────────────────────────

def load_portfolio() -> list[dict]:
    if os.path.exists(PORTFOLIO_FILE):
        with open(PORTFOLIO_FILE) as f:
            return json.load(f)
    return []


def save_portfolio(portfolio: list[dict]):
    with open(PORTFOLIO_FILE, "w") as f:
        json.dump(portfolio, f, indent=2)


# ─── PSX data fetcher ─────────────────────────────────────────────────────────

def fetch_dividends(symbol: str) -> list[dict]:
    """
    Fetch dividend history for a PSX symbol.
    Returns a list of dicts: {date, period, cash_pct, bonus_pct, announcement_date}
    cash_pct = cash dividend as % of face value (face value = Rs 10 typically)
    """
    symbol = symbol.upper()
    try:
        resp = requests.post(
            PSX_PAYOUT_URL,
            data={"symbol": symbol},
            headers={**HEADERS, "Referer": f"https://dps.psx.com.pk/company/{symbol}"},
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        console.print(f"[red]Failed to fetch data for {symbol}: {e}[/red]")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    rows = soup.select("tbody.tbl__body tr")

    dividends = []
    for row in rows:
        cols = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cols) < 4:
            continue

        ann_date_str, period, details, book_closure = cols[0], cols[1], cols[2], cols[3]

        # Parse announcement date
        try:
            ann_date = datetime.strptime(ann_date_str.split(" ")[0] + " " +
                                          ann_date_str.split(" ")[1] + " " +
                                          ann_date_str.split(" ")[2], "%B %d, %Y").date()
        except Exception:
            continue

        # Parse details: e.g. "60%(F) (D)" or "10%(i) (D) 10%(i) (B)"
        # (D) = Cash Dividend, (B) = Bonus shares
        cash_pct = 0.0
        bonus_pct = 0.0

        import re
        # Find all "XX%(label) (Type)" groups
        matches = re.findall(r"([\d.]+)%\([^)]*\)\s*\(([DB])\)", details)
        for pct_str, dtype in matches:
            pct = float(pct_str)
            if dtype == "D":
                cash_pct += pct
            elif dtype == "B":
                bonus_pct += pct

        # Parse ex-date from book closure (first date)
        ex_date = None
        bc_parts = book_closure.replace("\xa0", " ").split("-")
        if bc_parts:
            try:
                ex_date = datetime.strptime(bc_parts[0].strip(), "%d/%m/%Y").date()
            except Exception:
                ex_date = ann_date

        dividends.append({
            "announcement_date": ann_date.isoformat(),
            "ex_date": ex_date.isoformat() if ex_date else ann_date.isoformat(),
            "period": period,
            "cash_pct": cash_pct,
            "bonus_pct": bonus_pct,
            "details": details,
        })

    return dividends


# ─── Calculation ──────────────────────────────────────────────────────────────

FACE_VALUE = 10.0  # PKR face value per share for most PSX stocks


def calculate_dividends(holdings: list[dict], dividends_by_symbol: dict,
                         from_date: Optional[date] = None,
                         to_date: Optional[date] = None) -> dict:
    """
    Calculate total cash dividends received.
    A dividend is counted if ex_date >= purchase_date AND ex_date within [from_date, to_date].
    Returns summary per holding and totals.
    """
    results = []
    grand_total = 0.0

    for holding in holdings:
        symbol = holding["symbol"]
        shares = holding["shares"]
        purchase_date = date.fromisoformat(holding["purchase_date"])

        dividends = dividends_by_symbol.get(symbol, [])
        holding_total = 0.0
        div_events = []

        for div in dividends:
            ex_date = date.fromisoformat(div["ex_date"])

            # Must own shares on ex-date (bought before ex-date)
            if ex_date < purchase_date:
                continue

            # Apply date filter
            if from_date and ex_date < from_date:
                continue
            if to_date and ex_date > to_date:
                continue

            if div["cash_pct"] == 0:
                continue

            # Cash dividend = shares × (cash_pct / 100) × face_value
            amount = shares * (div["cash_pct"] / 100.0) * FACE_VALUE
            holding_total += amount
            div_events.append({
                "ex_date": div["ex_date"],
                "period": div["period"],
                "cash_pct": div["cash_pct"],
                "amount": amount,
                "details": div["details"],
            })

        grand_total += holding_total
        results.append({
            "symbol": symbol,
            "shares": shares,
            "purchase_date": holding["purchase_date"],
            "total": holding_total,
            "events": div_events,
        })

    return {"holdings": results, "grand_total": grand_total}


# ─── Display ──────────────────────────────────────────────────────────────────

def display_results(result: dict, period_label: str):
    console.print()
    console.print(Panel(f"[bold cyan]Dividend Summary — {period_label}[/bold cyan]", expand=False))

    for h in result["holdings"]:
        if not h["events"]:
            console.print(f"\n[dim]{h['symbol']}[/dim]: No dividends in this period")
            continue

        t = Table(
            title=f"{h['symbol']}  ({h['shares']:,} shares, bought {h['purchase_date']})",
            box=box.SIMPLE_HEAD,
            show_footer=True,
        )
        t.add_column("Ex-Date", style="dim")
        t.add_column("Period")
        t.add_column("Dividend %")
        t.add_column("Details")
        t.add_column("Amount (PKR)", justify="right", footer=f"[bold]{h['total']:,.2f}[/bold]")

        for ev in sorted(h["events"], key=lambda x: x["ex_date"]):
            t.add_row(
                ev["ex_date"],
                ev["period"],
                f"{ev['cash_pct']}%",
                ev["details"],
                f"{ev['amount']:,.2f}",
            )

        console.print(t)

    console.print(
        Panel(
            f"[bold green]Total Dividends: PKR {result['grand_total']:,.2f}[/bold green]",
            expand=False,
        )
    )


# ─── Portfolio management ─────────────────────────────────────────────────────

def show_portfolio(portfolio: list[dict]):
    if not portfolio:
        console.print("[yellow]Portfolio is empty.[/yellow]")
        return
    t = Table(title="Your PSX Portfolio", box=box.SIMPLE_HEAD)
    t.add_column("#", style="dim")
    t.add_column("Symbol")
    t.add_column("Shares", justify="right")
    t.add_column("Purchase Date")
    for i, h in enumerate(portfolio, 1):
        t.add_row(str(i), h["symbol"], f"{h['shares']:,}", h["purchase_date"])
    console.print(t)


def add_holding(portfolio: list[dict]):
    symbol = Prompt.ask("Company symbol (e.g. HBL, LUCK, MCB)").upper().strip()
    shares_str = Prompt.ask("Number of shares")
    try:
        shares = int(shares_str.replace(",", ""))
        assert shares > 0
    except (ValueError, AssertionError):
        console.print("[red]Invalid number of shares.[/red]")
        return

    date_str = Prompt.ask("Purchase date (YYYY-MM-DD)")
    try:
        purchase_date = date.fromisoformat(date_str)
    except ValueError:
        console.print("[red]Invalid date format. Use YYYY-MM-DD.[/red]")
        return

    portfolio.append({
        "symbol": symbol,
        "shares": shares,
        "purchase_date": purchase_date.isoformat(),
    })
    save_portfolio(portfolio)
    console.print(f"[green]Added {shares:,} shares of {symbol} (bought {purchase_date}).[/green]")


def remove_holding(portfolio: list[dict]):
    show_portfolio(portfolio)
    idx_str = Prompt.ask("Enter # to remove (or 0 to cancel)")
    try:
        idx = int(idx_str)
        if idx == 0:
            return
        assert 1 <= idx <= len(portfolio)
    except (ValueError, AssertionError):
        console.print("[red]Invalid selection.[/red]")
        return
    removed = portfolio.pop(idx - 1)
    save_portfolio(portfolio)
    console.print(f"[green]Removed {removed['symbol']} holding.[/green]")


# ─── Main menu ────────────────────────────────────────────────────────────────

def run_calculation(portfolio: list[dict], from_date: Optional[date], to_date: Optional[date], label: str):
    if not portfolio:
        console.print("[yellow]Portfolio is empty. Add holdings first.[/yellow]")
        return

    symbols = list({h["symbol"] for h in portfolio})
    console.print(f"\nFetching dividend data for: {', '.join(symbols)} ...")

    dividends_by_symbol = {}
    for sym in symbols:
        with console.status(f"[cyan]Fetching {sym}...[/cyan]"):
            dividends_by_symbol[sym] = fetch_dividends(sym)
        count = len(dividends_by_symbol[sym])
        console.print(f"  {sym}: {count} dividend record(s) found")

    result = calculate_dividends(portfolio, dividends_by_symbol, from_date, to_date)
    display_results(result, label)


def main():
    console.print(Panel("[bold]PSX Dividend Calculator[/bold]", subtitle="Pakistan Stock Exchange", expand=False))

    portfolio = load_portfolio()

    while True:
        console.print("\n[bold]Menu:[/bold]")
        console.print("  [cyan]1[/cyan] View portfolio")
        console.print("  [cyan]2[/cyan] Add holding")
        console.print("  [cyan]3[/cyan] Remove holding")
        console.print("  [cyan]4[/cyan] Calculate — All time")
        console.print("  [cyan]5[/cyan] Calculate — Year to Date (YTD)")
        console.print("  [cyan]6[/cyan] Calculate — This month")
        console.print("  [cyan]7[/cyan] Calculate — Custom date range")
        console.print("  [cyan]8[/cyan] Calculate — Specific year")
        console.print("  [cyan]q[/cyan] Quit")

        choice = Prompt.ask("\nChoice", default="1")

        today = date.today()

        if choice == "1":
            show_portfolio(portfolio)

        elif choice == "2":
            add_holding(portfolio)

        elif choice == "3":
            remove_holding(portfolio)

        elif choice == "4":
            run_calculation(portfolio, None, None, "All Time")

        elif choice == "5":
            from_date = date(today.year, 1, 1)
            run_calculation(portfolio, from_date, today, f"YTD ({today.year})")

        elif choice == "6":
            from_date = date(today.year, today.month, 1)
            run_calculation(portfolio, from_date, today, f"{today.strftime('%B %Y')}")

        elif choice == "7":
            from_str = Prompt.ask("From date (YYYY-MM-DD)")
            to_str = Prompt.ask("To date (YYYY-MM-DD)", default=today.isoformat())
            try:
                from_date = date.fromisoformat(from_str)
                to_date = date.fromisoformat(to_str)
                run_calculation(portfolio, from_date, to_date, f"{from_date} to {to_date}")
            except ValueError:
                console.print("[red]Invalid date format.[/red]")

        elif choice == "8":
            year_str = Prompt.ask("Year", default=str(today.year))
            try:
                year = int(year_str)
                from_date = date(year, 1, 1)
                to_date = date(year, 12, 31)
                run_calculation(portfolio, from_date, to_date, f"Year {year}")
            except ValueError:
                console.print("[red]Invalid year.[/red]")

        elif choice.lower() == "q":
            console.print("Goodbye!")
            break

        else:
            console.print("[red]Invalid choice.[/red]")


if __name__ == "__main__":
    main()

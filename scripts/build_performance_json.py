"""Build performance.json: 1, 3 and 6 month returns and the last 30 daily candles for every listed product
in the KIS catalog, from public market prices (FinanceDataReader). Logged-out visitors read this file.

Usage:
    python scripts/build_performance_json.py [--catalog path/to/kis-catalog.js] [--out path/to/performance.json]

Defaults: the catalog is ./kis-catalog.js or ./dist/kis-catalog.js, and the output is written next to it.
The same run also writes market.json next to it: the 200 day line state and the crash alert of the KOSPI and the S&P 500
(rules for the IRP check screen; see deploy/retirepilot-app/README.md).
Period definitions match the Edge Function: the return over N trading days is close[-1] / close[-(N+1)] - 1
with N = 20, 60 and 120. Prices are unadjusted public closes, so products that paid a distribution can differ
from the KIS adjusted series by the size of the distribution.

If fewer than MIN_SUCCESS of the products can be fetched, nothing is written and the exit code is 1, so a
scheduled run never replaces a good file with a broken one. Products that fail while others succeed keep their
previous entry (with its older lastDate).
"""

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import FinanceDataReader as fdr

ROOT = Path(__file__).resolve().parents[1]
MIN_SUCCESS = 0.8
LOOKBACK_DAYS = 330
PERIODS = {"oneMonth": 20, "threeMonths": 60, "sixMonths": 120}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def find_catalog():
    given = arg("--catalog")
    if given:
        return Path(given)
    for candidate in (ROOT / "kis-catalog.js", ROOT / "dist" / "kis-catalog.js"):
        if candidate.exists():
            return candidate
    raise SystemExit("kis-catalog.js not found")


def catalog_codes(path):
    first = path.read_text(encoding="utf-8").split("\n")[0]
    payload = json.loads(first[len("window.KIS_CATALOG = "):].rstrip().rstrip(";"))
    codes = []
    for item in payload["items"]:
        if re.fullmatch(r"[0-9A-Z]{6}", item["code"]) and item["code"] not in codes:
            codes.append(item["code"])
    return codes


def compact(value):
    """Whole prices are written as integers to keep the file small."""
    value = round(float(value), 2)
    return int(value) if value.is_integer() else value


def summarize(frame, as_of=None):
    """frame: DataFrame with Open, High, Low, Close indexed by date. Returns the entry or None."""
    frame = frame[(frame["Close"] > 0) & (frame["Open"] > 0) & (frame["High"] > 0) & (frame["Low"] > 0)]
    if as_of is not None:
        frame = frame[frame.index <= as_of]
    if len(frame) < 21:
        return None
    close = frame["Close"].astype(float)

    def after(days):
        if len(close) < days + 1:
            return None
        base = close.iloc[-(days + 1)]
        return round((close.iloc[-1] / base - 1) * 100, 2) if base else None

    tail = frame.tail(30)
    return {
        "periods": {name: after(days) for name, days in PERIODS.items()},
        "lastDate": frame.index[-1].strftime("%Y%m%d"),
        "candles": [[int(index.strftime("%Y%m%d")), compact(row.Open), compact(row.High), compact(row.Low), compact(row.Close)]
                    for index, row in tail.iterrows()],
    }


def fetch(code, start, end):
    for attempt in range(3):
        try:
            frame = fdr.DataReader(code, start, end)
            if frame is not None and len(frame):
                return frame
            return None
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


INDEX_SOURCES = {"kospi": ("코스피", ["KS11", "YAHOO:^KS11"]), "sp500": ("S&P500", ["US500", "YAHOO:^GSPC"])}
CONFIRM_DAYS = 10          # the 200 day line state changes only after this many consecutive trading days on the new side
CRASH_ONE_DAY = -0.05      # one day fall
CRASH_FIVE_DAY = -0.08     # five day fall
CRASH_WINDOW = 20          # trading days the crash alert stays on (the trigger day counts as the first)


def index_status(close):
    """close: index closes sorted by date. Returns the state used by the IRP rules (scripts/ backtest: halve+crash)."""
    close = close.dropna().astype(float)
    ma = close.rolling(200).mean()
    below = (close < ma).astype(int).tolist()
    state, pending, streak, since = below[0], below[0], 0, close.index[0]
    for date, value in zip(close.index, below):
        if value == pending:
            streak += 1
        else:
            pending, streak = value, 1
        if streak >= CONFIRM_DAYS and pending != state:
            state, since = pending, date
    raw_streak = 1
    while raw_streak < len(below) and below[-1 - raw_streak] == below[-1]:
        raw_streak += 1
    ret1 = close.pct_change()
    ret5 = close.pct_change(5)
    trigger = ((ret1 <= CRASH_ONE_DAY) | (ret5 <= CRASH_FIVE_DAY))
    triggered = trigger[trigger].index
    days_since = int((close.index > triggered[-1]).sum()) if len(triggered) else None
    first_trigger = None   # 지금 켜져 있는 경보의 최초 발동일(발동 사이 간격이 경보 기간 이내면 같은 경보로 본다)
    if len(triggered):
        first_pos = close.index.get_loc(triggered[-1])
        for ts in reversed(triggered[:-1]):
            pos = close.index.get_loc(ts)
            if first_pos - pos > CRASH_WINDOW:
                break
            first_pos = pos
        first_trigger = close.index[first_pos]
    return {
        "close": round(float(close.iloc[-1]), 2),
        "ma200": round(float(ma.iloc[-1]), 2),
        "below": bool(below[-1]),
        "rawStreak": int(raw_streak),
        "confirmed": "below" if state else "above",
        "confirmedSince": since.strftime("%Y%m%d"),
        "confirmDaysLeft": max(CONFIRM_DAYS - raw_streak, 0) if bool(below[-1]) != bool(state) else 0,
        "ret1": round(float(ret1.iloc[-1]) * 100, 2),
        "ret5": round(float(ret5.iloc[-1]) * 100, 2),
        "crash": {
            "active": bool(days_since is not None and days_since < CRASH_WINDOW),
            "triggerDate": triggered[-1].strftime("%Y%m%d") if len(triggered) else None,
            "firstTriggerDate": first_trigger.strftime("%Y%m%d") if first_trigger is not None else None,
            "daysSince": days_since,
        },
        "lastDate": close.index[-1].strftime("%Y%m%d"),
    }


def build_market(out_path, end):
    start = end - timedelta(days=700)
    indices = {}
    for key, (label, symbols) in INDEX_SOURCES.items():
        series = None
        for symbol in symbols:
            try:
                frame = fdr.DataReader(symbol, str(start), str(end))
                if frame is not None and len(frame) > 260 and (end - frame.index[-1].date()).days <= 7:
                    series = frame["Close"]
                    break
            except Exception:
                continue
        if series is None:
            print(f"market: {label} could not be fetched; market.json not written")
            return False
        indices[key] = {"name": label, **index_status(series)}
    payload = {
        "source": "Public index prices (FinanceDataReader).",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asOf": min(entry["lastDate"] for entry in indices.values()),
        "confirmDays": CONFIRM_DAYS,
        "crash": {"oneDay": CRASH_ONE_DAY * 100, "fiveDay": CRASH_FIVE_DAY * 100, "windowDays": CRASH_WINDOW},
        "indices": indices,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote market status to {out_path} as of {payload['asOf']}")
    return True


def main():
    catalog = find_catalog()
    out = Path(arg("--out", str(catalog.parent / "performance.json")))
    codes = catalog_codes(catalog)
    previous = {}
    if out.exists():
        try:
            previous = json.loads(out.read_text(encoding="utf-8")).get("items", {})
        except Exception:
            previous = {}
    end = datetime.now(timezone(timedelta(hours=9))).date()
    start = end - timedelta(days=LOOKBACK_DAYS)
    try:
        build_market(out.parent / "market.json", end)
    except Exception as error:      # the previous market.json stays in place; the page shows its date
        print(f"market: failed ({type(error).__name__}: {error})")
    items, failed = {}, []
    for index, code in enumerate(codes, 1):
        frame = fetch(code, str(start), str(end))
        entry = summarize(frame) if frame is not None else None
        if entry:
            items[code] = entry
        else:
            failed.append(code)
            if code in previous:
                items[code] = previous[code]
        if index % 100 == 0:
            print(f"{index}/{len(codes)} fetched, {len(failed)} failed so far", flush=True)
        time.sleep(0.05)
    fresh = len(codes) - len(failed)
    print(f"products {len(codes)}, fetched {fresh}, failed {len(failed)}")
    if fresh < len(codes) * MIN_SUCCESS:
        print(f"only {fresh / len(codes):.0%} fetched, below {MIN_SUCCESS:.0%}; the existing file is left untouched")
        return 1
    last_dates = [entry["lastDate"] for code, entry in items.items() if code not in failed]
    payload = {
        "source": "Public market prices (FinanceDataReader). Unadjusted closes; past returns do not guarantee future performance.",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asOf": max(last_dates) if last_dates else None,
        "count": len(items),
        "failedCodes": failed,
        "items": items,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(items)} products to {out} ({out.stat().st_size / 1024:.0f} KB), as of {payload['asOf']}")
    return 0



if __name__ == "__main__":
    sys.exit(main())

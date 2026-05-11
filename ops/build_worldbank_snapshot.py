#!/usr/bin/env python3
"""Build a local World Bank snapshot for the Three Intelligences Explorer.

Output:
  data/worldbank_snapshot.json

Load strategy:
  1. WGI governance indicators are fetched through the WGI DataBank source route.
  2. Standard WDI/ESG indicators are fetched through the normal World Bank indicator route.
  3. Each indicator records whether it loaded or failed, so the front end can show a heatmap.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT
DATA = BASE / "data"

COUNTRIES_PATH = DATA / "countries.json"
INDICATORS_PATH = DATA / "indicators.json"
OUT_PATH = DATA / "worldbank_snapshot.json"

WB_BASE = "https://api.worldbank.org/v2"
YEARS = "2010:2026"
PER_PAGE = 20000
SLEEP_BETWEEN_REQUESTS = 0.25
TIMEOUT_SECONDS = 45

# DataBank source id 1181 is the Worldwide Governance Indicators database.
# The normal WDI endpoint may return metadata/error payloads for WGI codes unless source is supplied.
WGI_SOURCE_ID = "1181"
WGI_CODES = {"GE.EST", "RL.EST", "CC.EST", "VA.EST", "RQ.EST", "PV.EST"}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_json(url: str):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "salmonofdoubt-intelligence-demo-snapshot/1.1",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw)


def make_indicator_urls(country_codes: str, indicator_code: str) -> list[str]:
    base_query = {
        "format": "json",
        "per_page": str(PER_PAGE),
        "date": YEARS,
    }

    urls = []

    if indicator_code in WGI_CODES:
        q = dict(base_query)
        q["source"] = WGI_SOURCE_ID
        urls.append(
            f"{WB_BASE}/country/{country_codes}/indicator/{indicator_code}?{urllib.parse.urlencode(q)}"
        )

    urls.append(
        f"{WB_BASE}/country/{country_codes}/indicator/{indicator_code}?{urllib.parse.urlencode(base_query)}"
    )

    return urls


def extract_rows(payload):
    if not isinstance(payload, list) or len(payload) < 2:
        return None

    rows = payload[1]

    if not isinstance(rows, list):
        return None

    return rows


def load_indicator(indicator: dict, country_codes: str, iso3_to_code: dict[str, str]) -> tuple[dict, dict | None]:
    code = indicator["code"]
    errors = []

    for url in make_indicator_urls(country_codes, code):
        try:
            payload = fetch_json(url)
            rows = extract_rows(payload)

            if rows is None:
                errors.append(f"payload did not contain a data array for URL {url}")
                continue

            values_for_indicator: dict[str, dict] = {}
            usable_rows = 0

            for row in rows:
                if not isinstance(row, dict):
                    continue

                value = row.get("value")
                iso3 = row.get("countryiso3code")
                year_raw = row.get("date")

                if value is None or not iso3 or not year_raw:
                    continue

                country_code = iso3_to_code.get(iso3)
                if not country_code:
                    continue

                try:
                    year = int(year_raw)
                    value = float(value)
                except (TypeError, ValueError):
                    continue

                current = values_for_indicator.get(country_code)

                if not current or year > int(current["year"]):
                    values_for_indicator[country_code] = {
                        "value": value,
                        "year": year,
                        "indicator": code,
                        "label": indicator.get("label", code),
                    }

                usable_rows += 1

            if usable_rows == 0 or not values_for_indicator:
                errors.append(f"no usable rows for URL {url}")
                continue

            loaded_record = {
                "code": code,
                "label": indicator.get("label", code),
                "layer": indicator.get("layer", "unknown"),
                "usableRows": usable_rows,
                "countryValues": len(values_for_indicator),
                "sourceRoute": "WGI source 1181" if code in WGI_CODES and f"source={WGI_SOURCE_ID}" in url else "default World Bank API",
            }

            return values_for_indicator, loaded_record

        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    failed_record = {
        "code": code,
        "label": indicator.get("label", code),
        "layer": indicator.get("layer", "unknown"),
        "reason": " | ".join(errors[-3:]) if errors else "unknown error",
    }

    return {}, failed_record


def main() -> int:
    countries = load_json(COUNTRIES_PATH)
    indicators = load_json(INDICATORS_PATH)

    country_codes = ";".join(country["code"] for country in countries)
    iso3_to_code = {country.get("iso3"): country["code"] for country in countries if country.get("iso3")}

    raw_values: dict[str, dict[str, dict]] = {}
    loaded = []
    failed = []

    for indicator in indicators:
        code = indicator["code"]
        values_for_indicator, record = load_indicator(indicator, country_codes, iso3_to_code)

        if values_for_indicator:
            for country_code, value_record in values_for_indicator.items():
                raw_values.setdefault(country_code, {})[code] = value_record
            loaded.append(record)
            print(f"loaded {code}: {record['countryValues']} countries, {record['usableRows']} usable rows via {record['sourceRoute']}")
        else:
            failed.append(record)
            print(f"failed {code}: {record['reason']}")

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    value_count = sum(len(v) for v in raw_values.values())
    countries_with_any_value = sum(1 for v in raw_values.values() if v)

    report = {
        "total": len(indicators),
        "loaded": loaded,
        "failed": failed,
        "values": value_count,
        "countriesWithAnyValue": countries_with_any_value,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "years": YEARS,
    }

    snapshot = {
        "meta": {
            "title": "Three Intelligences Explorer World Bank snapshot",
            "generated_at": report["generated_at"],
            "source": "World Bank API",
            "years": YEARS,
            "country_count": len(countries),
            "indicator_count": len(indicators),
            "loaded_indicator_count": len(loaded),
            "failed_indicator_count": len(failed),
            "value_count": value_count,
            "countries_with_any_value": countries_with_any_value,
        },
        "report": report,
        "rawValues": raw_values,
    }

    OUT_PATH.write_text(json.dumps(snapshot, indent=2, sort_keys=True), encoding="utf-8")

    print("")
    print(f"wrote {OUT_PATH}")
    print(f"loaded indicators: {len(loaded)}/{len(indicators)}")
    print(f"values: {value_count}")
    print(f"countries with any value: {countries_with_any_value}")

    if failed:
        print("failed indicators:")
        for item in failed:
            print(f"  - {item['code']}: {item['reason']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

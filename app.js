
const WB_BASE = "https://api.worldbank.org/v2";

const DEFAULT_CAMERA = { eye: { x: 1.55, y: 1.45, z: 1.2 } };

const state = {
  countries: [],
  indicators: [],
  rawValues: {},
  fallbackRows: [],
  scores: [],
  filtered: [],
  selectedRow: null,
  report: null,
  dataMode: "loading",
  hybridFallback: false,
  camera: DEFAULT_CAMERA
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const [countries, indicators] = await Promise.all([
      fetchJSON("data/countries.json"),
      fetchJSON("data/indicators.json")
    ]);

    state.countries = countries;
    state.indicators = indicators;
    state.fallbackRows = await loadFallbackScores();

    bindControls();
    populateRegionFilter();

    await loadBestAvailableData();

    applyFilters();
    renderTransitionLean(null);
    renderSelectedCountry(null);
    renderSelectedTheory(null);
    renderIndicatorHealthMap();
    updateDataProvenance();
    updateReportCta();
  } catch (error) {
    const target = document.getElementById("plot");
    if (target) {
      target.innerHTML = `<div class="warning-box">Could not initialise demo: ${escapeHtml(error.message)}</div>`;
    }
    console.error(error);
  }
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${url}`);
  return response.text();
}

function bindControls() {
  const controlIds = [
    "regionFilter",
    "countrySearch",
    "minSynergy",
    "colourMode",
    "showLandingBars",
    "showMaturityHalos",
    "showTheoryDiagnostics"
  ];

  controlIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    const eventName = el.tagName === "INPUT" && el.type === "text" ? "input" : "change";
    el.addEventListener(eventName, () => applyFilters());
  });

  const minSynergy = document.getElementById("minSynergy");
  if (minSynergy) {
    minSynergy.addEventListener("input", () => applyFilters());
  }

  const reset = document.getElementById("resetCamera");
  if (reset) {
    reset.addEventListener("click", () => {
      state.camera = DEFAULT_CAMERA;
      renderPlot();
    });
  }

  const clear = document.getElementById("clearFilters");
  if (clear) {
    clear.addEventListener("click", () => {
      const region = document.getElementById("regionFilter");
      const search = document.getElementById("countrySearch");
      const synergy = document.getElementById("minSynergy");
      const colour = document.getElementById("colourMode");

      if (region) region.value = "All regions";
      if (search) search.value = "";
      if (synergy) synergy.value = "0";
      if (colour) colour.value = "archetype";

      state.selectedRow = null;
      applyFilters();
      renderSelectedCountry(null);
      renderSelectedTheory(null);
      renderTransitionLean(null);
      updateReportCta();
    });
  }

  const pdf = document.getElementById("downloadCountryPdfReport");
  if (pdf) {
    pdf.addEventListener("click", downloadSelectedCountryPdfReport);
  }
}

function populateRegionFilter() {
  const select = document.getElementById("regionFilter");
  if (!select) return;

  const regions = Array.from(new Set(state.countries.map(c => c.region).filter(Boolean))).sort();

  select.innerHTML = [
    `<option value="All regions">All regions</option>`,
    ...regions.map(region => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`)
  ].join("");
}

async function loadBestAvailableData() {
  try {
    const snapshot = await fetchJSON("data/worldbank_snapshot.json");
    if (!snapshot || !snapshot.rawValues || !snapshot.report) {
      throw new Error("Snapshot file does not contain rawValues/report.");
    }

    state.rawValues = snapshot.rawValues;
    state.report = {
      ...snapshot.report,
      mode: snapshot.report.failed && snapshot.report.failed.length ? "partial-snapshot" : "snapshot",
      generated_at: snapshot.meta?.generated_at || snapshot.report.generated_at || null
    };

    const loadedCount = state.report.loaded?.length || 0;
    const valueCount = Number(state.report.values || 0);

    if (loadedCount < 3 || valueCount < 10) {
      throw new Error("Snapshot below usable threshold.");
    }

    state.scores = computeScores();
    fillMissingDimensionsFromFallback("World Bank snapshot");

    state.dataMode = state.hybridFallback
      ? `Hybrid snapshot data · ${loadedCount}/${state.report.total} indicators`
      : state.report.failed?.length
        ? `Partial snapshot data · ${loadedCount}/${state.report.total} indicators`
        : `Fresh snapshot data · ${loadedCount}/${state.report.total} indicators`;

    renderDataMode();
    return;
  } catch (snapshotError) {
    console.warn("Snapshot route failed. Trying browser fetch.", snapshotError);
  }

  try {
    const liveReport = await loadWorldBankData();
    state.report = liveReport;
    state.scores = computeScores();
    fillMissingDimensionsFromFallback("Browser live World Bank data");

    state.dataMode = state.hybridFallback
      ? `Hybrid live browser data · ${liveReport.loaded.length}/${liveReport.total} indicators`
      : liveReport.failed.length
        ? `Partial live browser data · ${liveReport.loaded.length}/${liveReport.total} indicators`
        : `Live browser data · ${liveReport.loaded.length}/${liveReport.total} indicators`;

    renderDataMode();
    return;
  } catch (liveError) {
    console.warn("Live route failed. Using fallback CSV.", liveError);
  }

  state.rawValues = {};
  state.report = {
    mode: "fallback",
    total: state.indicators.length,
    loaded: [],
    failed: state.indicators.map(indicator => ({
      code: indicator.code,
      label: indicator.label,
      layer: indicator.layer,
      reason: "Fallback mode active"
    })),
    values: 0,
    countriesWithAnyValue: 0,
    generated_at: null
  };

  state.dataMode = "Fallback illustrative data";
  state.scores = state.fallbackRows.map(row => ({ ...row, data_status: state.dataMode }));
  renderDataMode();
}

async function loadWorldBankData() {
  const countryCodes = state.countries.map(c => c.code).join(";");
  const years = "2010:2026";
  state.rawValues = {};

  const loaded = [];
  const failed = [];

  for (const indicator of state.indicators) {
    try {
      const url = `${WB_BASE}/country/${countryCodes}/indicator/${indicator.code}?format=json&per_page=20000&date=${years}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload[1] : null;
      if (!Array.isArray(rows)) throw new Error("No data array returned.");

      let usable = 0;

      rows.forEach(item => {
        if (!item || item.value === null || item.value === undefined || !item.countryiso3code) return;

        const country = state.countries.find(c => c.iso3 === item.countryiso3code);
        if (!country) return;

        const year = Number(item.date);
        const value = Number(item.value);
        if (!Number.isFinite(year) || !Number.isFinite(value)) return;

        const existing = state.rawValues[country.code]?.[indicator.code];

        if (!existing || year > existing.year) {
          if (!state.rawValues[country.code]) state.rawValues[country.code] = {};
          state.rawValues[country.code][indicator.code] = {
            value,
            year,
            indicator: indicator.code,
            label: indicator.label
          };
        }

        usable += 1;
      });

      if (usable > 0) {
        loaded.push({
          code: indicator.code,
          label: indicator.label,
          layer: indicator.layer,
          usableRows: usable
        });
      } else {
        failed.push({
          code: indicator.code,
          label: indicator.label,
          layer: indicator.layer,
          reason: "No usable rows returned."
        });
      }
    } catch (error) {
      failed.push({
        code: indicator.code,
        label: indicator.label,
        layer: indicator.layer,
        reason: error.message
      });
    }
  }

  const values = Object.values(state.rawValues).reduce((sum, countryValues) => {
    return sum + Object.keys(countryValues || {}).length;
  }, 0);

  if (values < state.countries.length * 2) {
    throw new Error("Too few usable live values.");
  }

  return {
    mode: failed.length ? "partial-live" : "live",
    total: state.indicators.length,
    loaded,
    failed,
    values,
    countriesWithAnyValue: Object.keys(state.rawValues).length,
    generated_at: new Date().toISOString()
  };
}

function renderDataMode() {
  const target = document.getElementById("dataMode");
  if (!target) return;

  const className = /fallback/i.test(state.dataMode)
    ? "fallback-status"
    : /hybrid|partial/i.test(state.dataMode)
      ? "partial-status snapshot-status"
      : "snapshot-status live-status";

  target.innerHTML = `<span class="status-pill ${className}">${escapeHtml(state.dataMode)}</span>`;
}

function updateDataProvenance() {
  const source = document.getElementById("dataSourceRoute");
  const updated = document.getElementById("dataUpdated");

  if (source) {
    if (/fallback/i.test(state.dataMode)) {
      source.textContent = "Illustrative fallback CSV";
    } else if (/hybrid/i.test(state.dataMode)) {
      source.textContent = "World Bank API snapshot + fallback-filled missing dimensions";
    } else if (/snapshot/i.test(state.dataMode)) {
      source.textContent = "World Bank API snapshot";
    } else {
      source.textContent = "World Bank API live fetch";
    }
  }

  if (updated) {
    const value = state.report?.generated_at;
    updated.textContent = value ? new Date(value).toISOString().slice(0, 10) : "Not applicable";
  }
}

function computeScores() {
  return state.countries.map(country => {
    const layerScores = { individual: [], collective: [], planetary: [] };
    const detail = [];

    state.indicators.forEach(indicator => {
      const raw = state.rawValues?.[country.code]?.[indicator.code];

      if (!raw) {
        detail.push({ ...indicator, raw: null, score: null, year: null });
        return;
      }

      const score = transformValue(Number(raw.value), indicator);
      layerScores[indicator.layer]?.push({ score, weight: Number(indicator.weight) || 1 });

      detail.push({
        ...indicator,
        raw: Number(raw.value),
        score,
        year: raw.year
      });
    });

    const individual = weightedAverage(layerScores.individual);
    const collective = weightedAverage(layerScores.collective);
    const planetary = weightedAverage(layerScores.planetary);
    const overall = average([individual, collective, planetary]);
    const completeness = state.indicators.length
      ? detail.filter(d => d.raw !== null && d.raw !== undefined).length / state.indicators.length
      : 0;

    return {
      country: country.name,
      code: country.code,
      iso3: country.iso3,
      region: country.region,
      individual_intelligence: individual,
      collective_intelligence: collective,
      planetary_intelligence: planetary,
      overall_synergy: overall,
      completeness,
      archetype: classifyArchetype(individual, collective, planetary),
      data_status: state.dataMode,
      detail
    };
  });
}

function fillMissingDimensionsFromFallback(sourceLabel) {
  const fallbackByCode = new Map(state.fallbackRows.map(row => [row.code, row]));
  let repaired = 0;

  state.scores = state.scores.map(row => {
    const fallback = fallbackByCode.get(row.code);
    if (!fallback) return row;

    const out = { ...row };
    let changed = false;

    ["individual_intelligence", "collective_intelligence", "planetary_intelligence"].forEach(key => {
      if (!Number.isFinite(Number(out[key])) && Number.isFinite(Number(fallback[key]))) {
        out[key] = Number(fallback[key]);
        changed = true;
      }
    });

    if (changed) {
      repaired += 1;
      out.overall_synergy = average([
        Number(out.individual_intelligence),
        Number(out.collective_intelligence),
        Number(out.planetary_intelligence)
      ]);
      out.archetype = classifyArchetype(
        Number(out.individual_intelligence),
        Number(out.collective_intelligence),
        Number(out.planetary_intelligence)
      );
      out.data_status = `${sourceLabel} with fallback-filled missing dimensions`;
    }

    return out;
  });

  state.hybridFallback = repaired > 0;
}

async function loadFallbackScores() {
  const text = await fetchText("data/country_scores_fallback.csv");
  const rows = parseCSV(text);

  return rows.map(row => ({
    country: row.country,
    code: row.code,
    iso3: row.iso3 || "",
    region: row.region,
    individual_intelligence: Number(row.individual_intelligence),
    collective_intelligence: Number(row.collective_intelligence),
    planetary_intelligence: Number(row.planetary_intelligence),
    overall_synergy: Number(row.overall_synergy),
    completeness: 0,
    archetype: classifyArchetype(
      Number(row.individual_intelligence),
      Number(row.collective_intelligence),
      Number(row.planetary_intelligence)
    ),
    data_status: row.data_status || "Fallback illustrative data",
    detail: []
  }));
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCSVLine(lines.shift());

  return lines.map(line => {
    const cells = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || ""]));
  });
}

function parseCSVLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function transformValue(value, indicator) {
  let score;

  switch (indicator.transform) {
    case "scale_0_1":
      score = value * 100;
      break;
    case "percent":
      score = value;
      break;
    case "capped_percent":
      score = (Math.min(value, Number(indicator.cap) || 100) / (Number(indicator.cap) || 100)) * 100;
      break;
    case "wgi_estimate":
      score = ((value + 2.5) / 5) * 100;
      break;
    case "linear":
      score = ((value - Number(indicator.min)) / (Number(indicator.max) - Number(indicator.min))) * 100;
      break;
    case "inverse_linear":
      score = 100 - ((value - Number(indicator.min)) / (Number(indicator.max) - Number(indicator.min))) * 100;
      break;
    default:
      score = value;
  }

  return clamp(score, 0, 100);
}

function weightedAverage(items) {
  const valid = (items || []).filter(d => Number.isFinite(d.score) && Number.isFinite(d.weight));
  const wsum = valid.reduce((sum, d) => sum + d.weight, 0);
  if (!valid.length || wsum === 0) return NaN;
  return valid.reduce((sum, d) => sum + d.score * d.weight, 0) / wsum;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return NaN;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function classifyArchetype(i, c, p) {
  if (i >= 70 && c >= 70 && p >= 65) return "High integration";
  if (i >= 70 && c < 65) return "Individual-rich, coordination-limited";
  if (c >= 70 && p < 55) return "Institutionally strong, planetary lag";
  if (p >= 65 && c < 65) return "Planet-aware, governance-limited";
  if (i < 55 && c < 55 && p < 55) return "Low composite capacity";
  return "Mixed transition";
}

function enrichTheoryFields(row) {
  if (!row) return null;

  const ecologicalPressure = estimateEcologicalPressure(row);
  const diagnostics = deriveDiagnostics(row, ecologicalPressure);
  const gap = matureTechnosphereGap(diagnostics, ecologicalPressure);
  const enriched = {
    ...row,
    ecological_pressure: ecologicalPressure,
    ...diagnostics,
    mature_technosphere_gap: gap
  };

  enriched.maturity_state = classifyMaturity(enriched);
  enriched.maturity_interpretation = maturityInterpretation(enriched);
  return enriched;
}

function estimateEcologicalPressure(row) {
  const detailPressure = (row.detail || [])
    .filter(d => d.layer === "planetary" && d.direction === "negative" && Number.isFinite(Number(d.score)))
    .map(d => ({ pressure: 100 - Number(d.score), weight: Number(d.weight) || 1 }));

  if (detailPressure.length) {
    const wsum = detailPressure.reduce((sum, d) => sum + d.weight, 0);
    return clamp(detailPressure.reduce((sum, d) => sum + d.pressure * d.weight, 0) / wsum);
  }

  return clamp(100 - Number(row.planetary_intelligence || 0));
}

function deriveDiagnostics(row, ecologicalPressure) {
  const i = Number(row.individual_intelligence || 0);
  const c = Number(row.collective_intelligence || 0);
  const p = Number(row.planetary_intelligence || 0);
  const safe = 100 - ecologicalPressure;

  return {
    emergence_score: clamp((i * 0.35) + (c * 0.35) + (p * 0.30)),
    network_information_score: clamp((c * 0.60) + (i * 0.20) + (p * 0.20)),
    semantic_feedback_score: clamp((c * 0.35) + (p * 0.55) + (safe * 0.10)),
    boundary_signal_score: clamp((p * 0.60) + (c * 0.25) + (safe * 0.15)),
    autopoiesis_score: clamp((p * 0.55) + (c * 0.30) + (safe * 0.15))
  };
}

function matureTechnosphereGap(diagnostics, ecologicalPressure) {
  const avgDiagnostic = average([
    diagnostics.emergence_score,
    diagnostics.network_information_score,
    diagnostics.semantic_feedback_score,
    diagnostics.boundary_signal_score,
    diagnostics.autopoiesis_score
  ]);

  return clamp(avgDiagnostic - ecologicalPressure * 0.35);
}

function classifyMaturity(row) {
  const gap = clamp(row.mature_technosphere_gap ?? 0);
  if (gap >= 75) return "Mature-candidate readiness";
  if (gap >= 50) return "Transitioning readiness";
  if (gap >= 25) return "Immature readiness";
  return "Emerging readiness";
}

function maturityInterpretation(row) {
  switch (row.maturity_state) {
    case "Mature-candidate readiness":
      return "This country is in the mature-candidate readiness band in this proxy model. It still sits within Earth's immature global technosphere, but shows comparatively strong readiness ingredients.";
    case "Transitioning readiness":
      return "This country is in the transitioning readiness band. It shows meaningful movement toward planetary self-regulation, but is not yet mature.";
    case "Immature readiness":
      return "This country is in the immature readiness band. Some capability is present, but planetary-scale feedback and self-regulation remain insufficient.";
    case "Emerging readiness":
      return "This country is in the emerging readiness band. Planetary-scale feedback and stewardship capacity remain early in this proxy model.";
    default:
      return "Readiness could not be classified clearly. Interpret cautiously where indicator completeness is limited.";
  }
}

function normaliseSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isAllRegion(value) {
  const v = normaliseSearch(value);
  return !v || v === "all" || v === "all regions" || v === "any" || v === "*";
}

function countryAliases(row) {
  const aliases = new Set([
    normaliseSearch(row.country),
    normaliseSearch(row.code),
    normaliseSearch(row.iso3)
  ]);

  if (row.code === "US" || row.iso3 === "USA" || /united states/i.test(row.country || "")) {
    ["usa", "us", "u s", "u s a", "america", "united states", "united states of america"].forEach(v => aliases.add(normaliseSearch(v)));
  }

  if (row.code === "GB" || row.iso3 === "GBR" || /united kingdom/i.test(row.country || "")) {
    ["uk", "u k", "britain", "great britain", "united kingdom", "england"].forEach(v => aliases.add(normaliseSearch(v)));
  }

  if (row.code === "KR" || row.iso3 === "KOR" || /korea/i.test(row.country || "")) {
    ["korea", "south korea", "republic of korea", "korea rep"].forEach(v => aliases.add(normaliseSearch(v)));
  }

  return Array.from(aliases).filter(Boolean);
}

function countryMatches(row, query) {
  const q = normaliseSearch(query);
  if (!q) return true;

  return countryAliases(row).some(alias =>
    alias === q || alias.startsWith(q) || alias.includes(q) || q.includes(alias)
  );
}

function bestCountryMatch(rows, query) {
  const q = normaliseSearch(query);
  if (!q) return null;

  return rows.find(row => countryAliases(row).some(alias => alias === q)) ||
    rows.find(row => countryAliases(row).some(alias => alias.startsWith(q))) ||
    rows.find(row => countryMatches(row, q)) ||
    null;
}

function plottableRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => enrichTheoryFields(row))
    .filter(row =>
      row &&
      Number.isFinite(Number(row.individual_intelligence)) &&
      Number.isFinite(Number(row.collective_intelligence)) &&
      Number.isFinite(Number(row.planetary_intelligence))
    );
}

function applyFilters() {
  const regionValue = document.getElementById("regionFilter")?.value || "";
  const searchValue = document.getElementById("countrySearch")?.value || "";
  const minSynergy = Number(document.getElementById("minSynergy")?.value || 0);
  const minSynergyValue = document.getElementById("minSynergyValue");

  if (minSynergyValue) minSynergyValue.textContent = String(minSynergy);

  const allRows = plottableRows(state.scores);
  const hasSearch = normaliseSearch(searchValue).length > 0;
  const hasRegion = !isAllRegion(regionValue);
  const hasSynergy = Number.isFinite(minSynergy) && minSynergy > 0;

  let rows;

  if (hasSearch) {
    rows = allRows.filter(row => countryMatches(row, searchValue));
  } else {
    rows = allRows.filter(row => {
      const regionOk = !hasRegion || row.region === regionValue;
      const synergyOk = !hasSynergy || Number(row.overall_synergy || 0) >= minSynergy;
      return regionOk && synergyOk;
    });
  }

  state.filtered = rows;

  updateSummary(rows);
  renderPlot();

  if (hasSearch) {
    const match = bestCountryMatch(rows, searchValue);
    if (match) selectRow(match);
  } else if (state.selectedRow && !rows.some(row => row.code === state.selectedRow.code)) {
    state.selectedRow = null;
    renderSelectedCountry(null);
    renderSelectedTheory(null);
    renderTransitionLean(null);
    updateReportCta();
  }
}

function updateSummary(rows) {
  const safeRows = plottableRows(rows);

  setText("displayedCount", String(safeRows.length));
  setText("avgIndividual", averageMetric(safeRows, "individual_intelligence"));
  setText("avgCollective", averageMetric(safeRows, "collective_intelligence"));
  setText("avgPlanetary", averageMetric(safeRows, "planetary_intelligence"));

  const completenessValues = safeRows.map(row => Number(row.completeness)).filter(Number.isFinite);
  const completeness = completenessValues.length
    ? Math.round((completenessValues.reduce((a, b) => a + b, 0) / completenessValues.length) * 100)
    : 0;

  setText("avgCompleteness", `${completeness}%`);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function averageMetric(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
  return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "0";
}

function axisRange(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
  if (!values.length) return [0, 100];

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(1, maxValue - minValue);
  const pad = Math.max(4, spread * 0.22);

  let low = Math.floor(Math.max(0, minValue - pad) / 5) * 5;
  let high = Math.ceil(Math.min(100, maxValue + pad) / 5) * 5;

  if (high - low < 20) {
    const mid = (high + low) / 2;
    low = Math.floor(Math.max(0, mid - 10) / 5) * 5;
    high = Math.ceil(Math.min(100, mid + 10) / 5) * 5;
  }

  return high > low ? [low, high] : [0, 100];
}

function plotRanges(rows) {
  return {
    x: axisRange(rows, "individual_intelligence"),
    y: axisRange(rows, "collective_intelligence"),
    z: axisRange(rows, "planetary_intelligence")
  };
}

function renderPlot() {
  const target = document.getElementById("plot");
  if (!target) return;

  const rows = plottableRows(state.filtered);

  if (!rows.length) {
    target.innerHTML = `<div class="warning-box">No countries match the current filters. Clear the search or choose “All regions”.</div>`;
    return;
  }

  const colourMode = document.getElementById("colourMode")?.value || "archetype";
  const ranges = plotRanges(rows);
  const traces = buildPlotTraces(rows, colourMode);

  const selected = state.selectedRow && rows.find(row => row.code === state.selectedRow.code);
  if (selected) traces.push(makeSelectedLocatorTrace(selected));

  if (document.getElementById("showMaturityHalos")?.checked) traces.unshift(makeMaturityHaloTrace(rows));
  if (document.getElementById("showLandingBars")?.checked) traces.push(makeLandingBarsTrace(rows));

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 0, r: 0, t: 10, b: 0 },
    showlegend: true,
    legend: {
      orientation: "h",
      x: 0,
      y: 1.04,
      font: { color: "#e5eefc", size: 12 },
      bgcolor: "rgba(0,0,0,0)"
    },
    scene: {
      bgcolor: "rgba(0,0,0,0)",
      camera: state.camera,
      xaxis: axisConfig("Individual intelligence", ranges.x),
      yaxis: axisConfig("Collective intelligence", ranges.y),
      zaxis: axisConfig("Planetary intelligence", ranges.z)
    }
  };

  const config = {
    responsive: true,
    displaylogo: false
  };

  Plotly.react(target, traces, layout, config).then(() => {
    if (target.removeAllListeners) {
      target.removeAllListeners("plotly_click");
      target.removeAllListeners("plotly_relayout");
    }

    if (target.on) {
      target.on("plotly_click", event => {
        const code = event?.points?.[0]?.customdata;
        const row = plottableRows(state.scores).find(item => item.code === code);
        if (row) selectRow(row);
      });

      target.on("plotly_relayout", event => {
        if (event && event["scene.camera"]) {
          state.camera = event["scene.camera"];
        }
      });
    }
  });
}

function axisConfig(title, range) {
  return {
    title,
    range,
    gridcolor: "rgba(153, 177, 255, 0.45)",
    zerolinecolor: "rgba(153, 177, 255, 0.22)",
    color: "#e5eefc"
  };
}

function buildPlotTraces(rows, colourMode) {
  if (colourMode === "synergy") {
    return [{
      type: "scatter3d",
      mode: "markers",
      name: "Overall synergy",
      x: rows.map(row => row.individual_intelligence),
      y: rows.map(row => row.collective_intelligence),
      z: rows.map(row => row.planetary_intelligence),
      customdata: rows.map(row => row.code),
      hovertemplate: rows.map(row => hoverTemplate(row)),
      marker: {
        size: rows.map(row => Math.max(6, Number(row.overall_synergy) / 9)),
        color: rows.map(row => Number(row.overall_synergy)),
        colorscale: "Viridis",
        showscale: true,
        opacity: 0.9,
        line: { width: 0.8, color: "rgba(255,255,255,0.38)" }
      }
    }];
  }

  const groups = new Map();

  rows.forEach(row => {
    const key = colourMode === "region" ? row.region || "Unknown region" : row.archetype || "Unclassified";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  return Array.from(groups.entries()).map(([name, groupRows], index) => ({
    type: "scatter3d",
    mode: "markers",
    name,
    x: groupRows.map(row => row.individual_intelligence),
    y: groupRows.map(row => row.collective_intelligence),
    z: groupRows.map(row => row.planetary_intelligence),
    customdata: groupRows.map(row => row.code),
    hovertemplate: groupRows.map(row => hoverTemplate(row)),
    marker: {
      size: groupRows.map(row => Math.max(6, Number(row.overall_synergy) / 9)),
      color: colourFor(name, index),
      opacity: 0.9,
      line: { width: 0.8, color: "rgba(255,255,255,0.38)" }
    }
  }));
}

function colourFor(name, index = 0) {
  const fixed = {
    "High integration": "#38bdf8",
    "Individual-rich, coordination-limited": "#f97316",
    "Institutionally strong, planetary lag": "#22c55e",
    "Planet-aware, governance-limited": "#8b5cf6",
    "Low composite capacity": "#ef4444",
    "Mixed transition": "#a78bfa",
    "Europe": "#ef4444",
    "North America": "#a78bfa",
    "South America": "#22c55e",
    "Asia": "#f97316",
    "Africa": "#f59e0b",
    "Oceania": "#8d6e63"
  };

  const palette = ["#38bdf8", "#f97316", "#22c55e", "#ef4444", "#a78bfa", "#f59e0b", "#14b8a6"];
  return fixed[name] || palette[index % palette.length];
}

function hoverTemplate(row) {
  return [
    `<b>${escapeHtml(row.country)}</b>`,
    `Individual: ${Number(row.individual_intelligence).toFixed(1)}`,
    `Collective: ${Number(row.collective_intelligence).toFixed(1)}`,
    `Planetary: ${Number(row.planetary_intelligence).toFixed(1)}`,
    `Synergy: ${Number(row.overall_synergy).toFixed(1)}`,
    `Readiness: ${Number(row.mature_technosphere_gap).toFixed(1)}`,
    `Archetype: ${escapeHtml(row.archetype || "n/a")}`
  ].join("<br>") + "<extra></extra>";
}

function makeSelectedLocatorTrace(row) {
  const x = Number(row.individual_intelligence);
  const y = Number(row.collective_intelligence);
  const z = Number(row.planetary_intelligence);

  return {
    type: "scatter3d",
    mode: "lines+markers",
    name: "Selected locator",
    x: [x, x, null, x, x, null, 0, x, null, x],
    y: [y, y, null, 0, y, null, y, y, null, y],
    z: [0, z, null, z, z, null, z, z, null, z],
    customdata: [null, null, null, null, null, null, null, null, null, row.code],
    hovertemplate: "<b>%{text}</b><br>Selected country locator<extra></extra>",
    text: [null, null, null, null, null, null, null, null, null, row.country],
    showlegend: false,
    line: { width: 2, color: "rgba(255,255,255,0.9)" },
    marker: {
      size: [0, 0, 0, 0, 0, 0, 0, 0, 0, 8],
      color: "rgba(255,255,255,1)",
      line: { width: 1.5, color: "rgba(255,255,255,1)" }
    }
  };
}

function makeLandingBarsTrace(rows) {
  const x = [];
  const y = [];
  const z = [];

  rows.forEach(row => {
    x.push(row.individual_intelligence, row.individual_intelligence, null);
    y.push(row.collective_intelligence, row.collective_intelligence, null);
    z.push(0, row.planetary_intelligence, null);
  });

  return {
    type: "scatter3d",
    mode: "lines",
    name: "Landing bars",
    x,
    y,
    z,
    hoverinfo: "skip",
    line: { width: 2, color: "rgba(180, 210, 255, 0.25)" }
  };
}

function makeMaturityHaloTrace(rows) {
  return {
    type: "scatter3d",
    mode: "markers",
    name: "Maturity rings",
    x: rows.map(row => row.individual_intelligence),
    y: rows.map(row => row.collective_intelligence),
    z: rows.map(row => row.planetary_intelligence),
    hoverinfo: "skip",
    showlegend: false,
    marker: {
      size: rows.map(row => Math.max(16, row.overall_synergy / 3.9)),
      color: rows.map(row => maturityColour(row.maturity_state, 0.18)),
      opacity: 0.55,
      line: { width: 2.5, color: rows.map(row => maturityColour(row.maturity_state, 0.72)) }
    }
  };
}

function maturityColour(label, alpha = 0.26) {
  switch (label) {
    case "Mature-candidate readiness":
      return `rgba(94, 234, 212, ${alpha})`;
    case "Transitioning readiness":
      return `rgba(110, 168, 255, ${alpha})`;
    case "Immature readiness":
      return `rgba(251, 191, 36, ${alpha})`;
    case "Emerging readiness":
      return `rgba(139, 92, 246, ${alpha})`;
    default:
      return `rgba(168, 180, 207, ${alpha})`;
  }
}

function selectRow(row) {
  const enriched = enrichTheoryFields(row);
  state.selectedRow = enriched;

  renderSelectedCountry(enriched);
  renderSelectedTheory(enriched);
  renderTransitionLean(enriched);
  updateReportCta();
  renderPlot();
}

function renderSelectedCountry(row) {
  const target = document.getElementById("selectedCountry");
  if (!target) return;

  if (!row) {
    target.innerHTML = `<p class="muted">Click a marker in the 3D plot to inspect details, source years, and score logic.</p>`;
    return;
  }

  const used = (row.detail || []).filter(d => d.raw !== null && d.raw !== undefined).length;
  const total = state.indicators.length || (row.detail || []).length || 0;

  target.innerHTML = `
    <div class="selected-country-card">
      <h3 class="selected-country-name"><span class="country-mention-highlight">${escapeHtml(row.country)}</span></h3>

      <div class="model-status-strip compact">
        <span class="model-status-pill">${escapeHtml(row.region || "Unknown region")}</span>
        <span class="model-status-pill">${escapeHtml(row.archetype || "Unclassified")}</span>
        <span class="model-status-pill">${escapeHtml(row.data_status || state.dataMode)}</span>
      </div>

      <div class="metric-grid selected-metrics">
        ${metricCard("Individual", row.individual_intelligence)}
        ${metricCard("Collective", row.collective_intelligence)}
        ${metricCard("Planetary", row.planetary_intelligence)}
        ${metricCard("Synergy", row.overall_synergy)}
      </div>

      <div class="selected-diagnostics">
        <h4>Planetary-intelligence diagnostics</h4>
        <span class="status-pill ${maturityClass(row.maturity_state)}">${escapeHtml(row.maturity_state)}</span>
        <div class="metric-grid compact-metrics">
          ${metricCard("Mature technosphere gap", row.mature_technosphere_gap)}
          ${metricCard("Ecological pressure", row.ecological_pressure)}
        </div>
        ${renderDiagnosticBars(row)}
      </div>

      ${renderComparisonContext(row)}

      <details class="indicator-detail-disclosure source-transparency">
        <summary>
          <span>Source transparency</span>
          <small>${used} / ${total} indicators used</small>
        </summary>
        ${renderIndicatorDetailTable(row)}
      </details>

      <p class="maturity-interpretation">${escapeHtml(row.maturity_interpretation)}</p>
    </div>
  `;
}

function metricCard(label, value) {
  return `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${formatNumber(value)}</strong>
    </div>
  `;
}

function renderDiagnosticBars(row) {
  const diagnostics = [
    ["Emergence", row.emergence_score],
    ["Network information", row.network_information_score],
    ["Semantic feedback", row.semantic_feedback_score],
    ["Boundaries and signals", row.boundary_signal_score],
    ["Autopoiesis", row.autopoiesis_score]
  ];

  return `
    <div class="diagnostic-bars">
      ${diagnostics.map(([label, value]) => `
        <div class="diagnostic-row">
          <span class="diagnostic-label">${escapeHtml(label)}</span>
          <span class="diagnostic-track"><span class="diagnostic-fill" style="width:${clamp(value)}%"></span></span>
          <span class="diagnostic-value">${formatNumber(value, 0)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderComparisonContext(row) {
  const rows = plottableRows(state.filtered.length > 1 ? state.filtered : state.scores);
  const displayedAverage = average(rows.map(r => Number(r.mature_technosphere_gap)));
  const regionRows = rows.filter(r => r.region === row.region);
  const regionAverage = average(regionRows.map(r => Number(r.mature_technosphere_gap)));
  const top = rows.slice().sort((a, b) => Number(b.mature_technosphere_gap) - Number(a.mature_technosphere_gap))[0];
  const topDelta = top ? Number(row.mature_technosphere_gap) - Number(top.mature_technosphere_gap) : NaN;

  return `
    <div class="comparison-context">
      <h4>Comparison context</h4>
      <div class="metric-grid compact-metrics">
        ${metricCard("Displayed average", displayedAverage)}
        ${metricCard(`${row.region || "Region"} average`, regionAverage)}
        <div class="metric-card"><span>Top readiness</span><strong>${escapeHtml(top?.country || "n/a")}</strong></div>
      </div>
      <table>
        <thead><tr><th>Metric</th><th>${escapeHtml(row.country)}</th><th>Displayed avg</th><th>Δ</th></tr></thead>
        <tbody>
          ${comparisonRow("Readiness", row.mature_technosphere_gap, displayedAverage)}
          ${comparisonRow("Individual", row.individual_intelligence, average(rows.map(r => Number(r.individual_intelligence))))}
          ${comparisonRow("Collective", row.collective_intelligence, average(rows.map(r => Number(r.collective_intelligence))))}
          ${comparisonRow("Planetary", row.planetary_intelligence, average(rows.map(r => Number(r.planetary_intelligence))))}
        </tbody>
      </table>
      <p class="muted small">Against the current top-readiness country, <strong>${escapeHtml(row.country)}</strong> is ${formatSigned(topDelta)} readiness points away.</p>
    </div>
  `;
}

function comparisonRow(label, value, avgValue) {
  const delta = Number(value) - Number(avgValue);
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${formatNumber(value)}</td>
      <td>${formatNumber(avgValue)}</td>
      <td>${formatSigned(delta)}</td>
    </tr>
  `;
}

function renderIndicatorDetailTable(row) {
  const detail = row.detail || [];

  if (!detail.length) {
    return `<p class="muted small">Fallback dataset does not include per-indicator source detail.</p>`;
  }

  return `
    <div class="indicator-detail-content">
      <table class="indicator-detail-table">
        <thead>
          <tr>
            <th>Layer</th>
            <th>Indicator</th>
            <th>Raw value</th>
            <th>Score</th>
            <th>Year</th>
          </tr>
        </thead>
        <tbody>
          ${detail.map(d => `
            <tr>
              <td>${escapeHtml(d.layer || "n/a")}</td>
              <td>${escapeHtml(d.label || d.code || "n/a")}</td>
              <td>${d.raw === null || d.raw === undefined ? "missing" : formatNumber(d.raw, 3)}</td>
              <td>${d.score === null || d.score === undefined ? "missing" : formatNumber(d.score)}</td>
              <td>${escapeHtml(d.year || "n/a")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSelectedTheory(row) {
  const target = document.getElementById("selectedTheory");
  if (!target) return;

  if (!row) {
    target.innerHTML = `<p class="muted">Click a country marker to view its maturity state, diagnostic bars, and mature-technosphere gap.</p>`;
    return;
  }

  const show = document.getElementById("showTheoryDiagnostics")?.checked;
  if (!show) {
    target.innerHTML = `<p class="muted">Theory diagnostics are hidden. Enable “Show theory diagnostics” in the controls.</p>`;
    return;
  }

  target.innerHTML = `
    <div class="selected-theory-profile">
      <h4>Planetary-intelligence diagnostics</h4>
      <span class="status-pill ${maturityClass(row.maturity_state)}">${escapeHtml(row.maturity_state)}</span>
      <div class="metric-grid compact-metrics">
        ${metricCard("Mature technosphere gap", row.mature_technosphere_gap)}
        ${metricCard("Ecological pressure", row.ecological_pressure)}
      </div>
      ${renderDiagnosticBars(row)}
      <p class="muted">${escapeHtml(row.maturity_interpretation)}</p>
    </div>
  `;
}

function renderTransitionLean(row) {
  const target = document.getElementById("transitionLean");
  updateGlobalContextBubble(row);

  if (!target) return;

  if (!row) {
    target.innerHTML = `<p class="transition-lean-note">Click a country to see its readiness position inside the current global immature-technosphere context.</p>`;
    return;
  }

  const gap = clamp(row.mature_technosphere_gap);
  let zone = "early readiness";
  if (gap >= 75) zone = "mature-candidate readiness";
  else if (gap >= 50) zone = "transition-leaning readiness";
  else if (gap >= 25) zone = "immature-readiness";

  target.innerHTML = `
    <div class="transition-lean-current">
      <div class="current-stage-header">
        <div class="current-stage-heading-group">
          <h4 class="current-stage-heading">Country readiness inside the current global state</h4>
          <p class="current-stage-country-line">
            <strong class="country-mention-highlight">${escapeHtml(row.country)}</strong> · ${escapeHtml(row.maturity_state)}
          </p>
        </div>
        <span class="current-stage-score ${maturityClass(row.maturity_state)}">${formatNumber(gap, 0)} / 100</span>
      </div>

      <div class="current-stage-readiness">
        <div class="current-stage-track">
          <span class="current-stage-marker ${maturityClass(row.maturity_state)}" style="left:${gap}%"></span>
        </div>
        <div class="current-stage-labels">
          <span>Emerging</span>
          <span>Immature</span>
          <span>Transitioning</span>
          <span>Mature-candidate</span>
        </div>
      </div>

      <p class="transition-lean-warning">
        <strong>${escapeHtml(row.country)}</strong> is not being placed in the biosphere stages.
        It is a country-level subsystem inside Earth's current <strong>immature technosphere</strong>,
        classified here as <strong>${escapeHtml(row.maturity_state)}</strong> and sitting in the
        <strong>${escapeHtml(zone)}</strong> zone.
      </p>
    </div>
  `;
}

function updateGlobalContextBubble(row) {
  const active = document.querySelector(".transition-step.active");
  if (!active) return;

  active.querySelectorAll(".bubble-country-indicator").forEach(el => el.remove());
  active.classList.remove("has-country-indicator");

  if (!row) return;

  const gap = clamp(row.mature_technosphere_gap);
  const indicator = document.createElement("div");
  indicator.className = "bubble-country-indicator";
  indicator.innerHTML = `
    <span class="bubble-country-track">
      <span class="bubble-country-fill" style="width:${gap}%"></span>
    </span>
  `;

  active.appendChild(indicator);
  active.classList.add("has-country-indicator");
}

function updateReportCta() {
  const text = document.getElementById("countryReportDownloadText");
  const button = document.getElementById("downloadCountryPdfReport");
  const row = state.selectedRow;

  if (!text || !button) return;

  if (!row) {
    text.textContent = "Select a country in the 3D plot to export the country profile, planetary-context interpretation, diagnostics, comparison context, indicator source transparency, limitations, and APA 7 reuse note.";
    button.textContent = "Select a country first";
    button.disabled = true;
    return;
  }

  text.innerHTML = `
    Export the report for <strong class="country-mention-highlight">${escapeHtml(row.country)}</strong>.
    The PDF includes the country profile, readiness interpretation, planetary context, diagnostics,
    comparison context, indicator source transparency, limitations, and APA 7 reuse note.
  `;
  button.textContent = `Download ${row.country} PDF report`;
  button.disabled = false;
}

function renderIndicatorHealthMap() {
  const target = document.getElementById("liveIndicatorHeatmap");
  if (!target) return;

  const loaded = new Map((state.report?.loaded || []).map(d => [d.code, d]));
  const failed = new Map((state.report?.failed || []).map(d => [d.code, d]));
  const isFallback = /fallback/i.test(state.dataMode);

  const cells = state.indicators.map(indicator => {
    let status = "fallback";
    let title = "Fallback mode active.";

    if (!isFallback && loaded.has(indicator.code)) {
      status = "live";
      title = `${indicator.label}: available in current data snapshot.`;
    } else if (!isFallback && failed.has(indicator.code)) {
      status = "skipped";
      title = describeIndicatorProblem(indicator);
    }

    return `<span class="indicator-health-cell ${status}" title="${escapeHtml(title)}">${escapeHtml((indicator.layer || "?").slice(0, 1).toUpperCase())}</span>`;
  }).join("");

  const summary = `${escapeHtml(state.dataMode)} · ${state.report?.values || 0} values · ${state.report?.countriesWithAnyValue || state.countries.length} countries`;

  target.innerHTML = `
    <div class="indicator-health-summary">${summary}</div>
    <div class="indicator-health-grid">${cells}</div>
    <div class="indicator-health-legend">
      <span><i class="live"></i>live/snapshot</span>
      <span><i class="skipped"></i>skipped</span>
      <span><i class="fallback"></i>fallback</span>
    </div>
  `;
}

function describeIndicatorProblem(indicator) {
  if (["GE.EST", "RL.EST", "CC.EST", "VA.EST", "RQ.EST"].includes(indicator.code)) {
    return "Governance indicator unavailable in this snapshot route. The collective dimension is fallback-filled where needed and labelled.";
  }

  return "Indicator unavailable in this data run. The model continues with available indicators and labels missing or fallback-filled parts.";
}

function downloadSelectedCountryPdfReport() {
  const row = state.selectedRow ? enrichTheoryFields(state.selectedRow) : null;
  if (!row) {
    alert("Select a country first.");
    return;
  }

  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    openPrintableCountryReport(row);
    return;
  }

  const doc = new jsPDFCtor({ orientation: "portrait", unit: "mm", format: "a4" });
  const margin = 15;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - margin * 2;
  let y = 16;

  const colours = {
    navy: [11, 18, 32],
    panel: [20, 32, 52],
    teal: [94, 234, 212],
    red: [255, 90, 95],
    muted: [96, 108, 132],
    text: [28, 36, 52],
    pale: [244, 248, 252]
  };

  const addPageIfNeeded = height => {
    if (y + height > pageHeight - 20) {
      doc.addPage();
      y = 18;
    }
  };

  const addSection = (title, subtitle = "") => {
    addPageIfNeeded(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...colours.navy);
    doc.text(title, margin, y);
    y += 5.5;

    if (subtitle) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...colours.muted);
      const lines = doc.splitTextToSize(subtitle, usableWidth);
      doc.text(lines, margin, y);
      y += lines.length * 4.2 + 2;
    }

    doc.setDrawColor(60, 84, 120);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;
  };

  const addPara = text => {
    addPageIfNeeded(14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.2);
    doc.setTextColor(...colours.text);
    const lines = doc.splitTextToSize(String(text), usableWidth);

    lines.forEach(line => {
      addPageIfNeeded(5);
      doc.text(line, margin, y);
      y += 4.5;
    });

    y += 2;
  };

  const addTable = options => {
    doc.autoTable({
      margin: { left: margin, right: margin },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 2.2 },
      headStyles: { fillColor: colours.panel, textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [248, 251, 255] },
      ...options
    });
    y = doc.lastAutoTable.finalY + 8;
  };

  const comparisonRows = plottableRows(state.filtered.length > 1 ? state.filtered : state.scores);
  const displayedAverage = average(comparisonRows.map(r => Number(r.mature_technosphere_gap)));
  const top = comparisonRows.slice().sort((a, b) => Number(b.mature_technosphere_gap) - Number(a.mature_technosphere_gap))[0];

  doc.setFillColor(...colours.navy);
  doc.rect(0, 0, pageWidth, 48, "F");
  doc.setFillColor(...colours.teal);
  doc.rect(0, 47, pageWidth, 1.2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...colours.teal);
  doc.text("EXPERIMENTAL SYSTEMS INTELLIGENCE", margin, 14);

  doc.setFontSize(21);
  doc.setTextColor(255, 255, 255);
  doc.text("Three Intelligences Explorer", margin, 25);

  doc.setFontSize(15);
  doc.setTextColor(...colours.red);
  doc.text(`${row.country} country report`, margin, 36);

  y = 58;

  addSection("Executive interpretation");
  addPara(`${row.country} is classified as ${row.maturity_state} with a readiness score of ${formatNumber(row.mature_technosphere_gap)}/100 in this proxy model. This is a systems-readiness profile, not a national intelligence ranking.`);

  addSection("1. Score summary", "Core scores for the selected country. All scores use a 0 to 100 proxy scale.");
  addTable({
    startY: y,
    head: [["Metric", "Value", "Meaning"]],
    body: [
      ["Readiness score", `${formatNumber(row.mature_technosphere_gap)} / 100`, "Mature-technosphere readiness proxy"],
      ["Readiness band", row.maturity_state, "Position inside the current immature global technosphere"],
      ["Individual intelligence", `${formatNumber(row.individual_intelligence)} / 100`, "Human capability, education, health, and knowledge access"],
      ["Collective intelligence", `${formatNumber(row.collective_intelligence)} / 100`, "Institutional coordination and governance"],
      ["Planetary intelligence", `${formatNumber(row.planetary_intelligence)} / 100`, "Stewardship and Earth-system feedback capacity"],
      ["Ecological pressure", `${formatNumber(row.ecological_pressure)} / 100`, "Pressure derived from negative planetary indicators where available"]
    ]
  });

  addSection("2. Planetary-context interpretation");
  addPara("Earth is treated here as an immature technosphere overall: humanity has planetary-scale technological effects, but not yet mature planetary self-regulation. Countries are scored as subsystems inside that condition.");
  addPara(row.maturity_interpretation);

  addSection("3. Diagnostics");
  addTable({
    startY: y,
    head: [["Diagnostic", "Score", "Interpretation"]],
    body: [
      ["Emergence", formatNumber(row.emergence_score), "Capability arising above individual actors"],
      ["Network information", formatNumber(row.network_information_score), "Institutional and informational connectivity"],
      ["Semantic feedback", formatNumber(row.semantic_feedback_score), "Environmental signals becoming meaningful for action"],
      ["Boundaries and signals", formatNumber(row.boundary_signal_score), "Planetary limits are detected and acted upon"],
      ["Autopoiesis", formatNumber(row.autopoiesis_score), "Capacity to maintain long-term conditions of existence"]
    ]
  });

  addSection("4. Comparison context");
  addTable({
    startY: y,
    head: [["Context", "Value"]],
    body: [
      ["Displayed average readiness", formatNumber(displayedAverage)],
      ["Top readiness country", top?.country || "n/a"],
      ["Top readiness score", top ? formatNumber(top.mature_technosphere_gap) : "n/a"]
    ]
  });

  addSection("5. Source transparency");
  addPara(`Data mode: ${state.dataMode}. Indicator source: ${document.getElementById("dataSourceRoute")?.textContent || "n/a"}. Archived release DOI: 10.5281/zenodo.19633908.`);

  addTable({
    startY: y,
    head: [["Layer", "Indicator", "Raw", "Score", "Year"]],
    body: (row.detail || []).length
      ? row.detail.map(d => [
          d.layer || "n/a",
          d.label || d.code || "n/a",
          d.raw === null || d.raw === undefined ? "missing" : formatNumber(d.raw, 3),
          d.score === null || d.score === undefined ? "missing" : formatNumber(d.score),
          d.year || "n/a"
        ])
      : [["n/a", "Fallback dataset does not include per-indicator detail", "n/a", "n/a", "n/a"]],
    styles: { fontSize: 7 }
  });

  addSection("6. Authorship, citation and reuse", "Academic reuse is welcome with attribution. Please cite this prototype using APA 7.");
  addPara("This report was generated from the Three Intelligences Explorer prototype by André Baumann. The model logic, indicator choices, interpretation text, and report structure should be cited when reused, adapted, or discussed.");
  addPara("Suggested APA 7 citation: Baumann, A. (2026). Three Intelligences Explorer [Interactive prototype]. Zenodo. https://doi.org/10.5281/zenodo.19633908");
  addPara("Please do not present this report, the model design, or its explanatory text as your own unpublished work.");

  addSection("7. Model limitations");
  addPara("The model uses public proxy indicators. Proxy indicators are imperfect, country-level scores hide internal variation, and fallback-filled dimensions should be interpreted cautiously. Changing indicators, weights, thresholds, or transformations will change the results.");

  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...colours.muted);
    doc.text("Three Intelligences Explorer · Prototype model · Not a ranking", margin, pageHeight - 8);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, pageHeight - 8, { align: "right" });
  }

  doc.save(reportFileName(row.country));
}

function openPrintableCountryReport(row) {
  const win = window.open("", "_blank");
  if (!win) return;

  win.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(row.country)} report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.5; }
          table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
          th, td { border-bottom: 1px solid #ddd; padding: 0.4rem; text-align: left; }
          th { background: #f2f2f2; }
        </style>
      </head>
      <body>
        <h1>Three Intelligences Explorer: ${escapeHtml(row.country)}</h1>
        <p>This is a reasoning instrument, not a definitive ranking.</p>
        <p>${escapeHtml(row.maturity_interpretation || "")}</p>
        <h2>Suggested APA 7 citation</h2>
        <p>Baumann, A. (2026). <em>Three Intelligences Explorer</em> [Interactive prototype]. Zenodo. https://doi.org/10.5281/zenodo.19633908</p>
        <script>window.print();</script>
      </body>
    </html>
  `);
  win.document.close();
}

function reportFileName(country) {
  return `three-intelligences-${String(country || "country").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-report.pdf`;
}

function formatNumber(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function formatSigned(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  return n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function maturityClass(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

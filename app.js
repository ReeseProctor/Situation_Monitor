const config = window.SITUATION_MONITOR_CONFIG || {};

const state = {
  sensorRefreshMs: config.refreshMs || 5000,
  weatherRefreshMs: config.weatherRefreshMs || 1800000,
  marketRefreshMs: config.marketRefreshMs || 300000,
  sensorEndpoint: config.endpoint || "/api/air",
  weatherEndpoint: config.weatherEndpoint || "/api/weather",
  marketEndpoint: config.marketEndpoint || "/api/markets",
  wifiSpeedtestEndpoint: config.wifiSpeedtestEndpoint || "/api/wifi-speedtest",
  layoutStorageKey: "situation-monitor-layout-v1",
  lifeSettingsStorageKey: "situation-monitor-life-settings-v1",
  lastSensorAt: null,
  layoutEdit: false,
  draggedModuleId: null,
  speedtestRunning: false,
  sensorTimer: null,
  marketTimer: null,
  weatherTimer: null
};

const DEFAULT_LAYOUT_ORDER = Array.from(document.querySelectorAll(".dashboard > .panel[data-module-id]"))
  .map((panel) => panel.dataset.moduleId);

const elements = {
  dashboard: document.querySelector("#dashboard"),
  clock: document.querySelector("#clock"),
  layoutToggleButton: document.querySelector("#layout-toggle-button"),
  layoutResetButton: document.querySelector("#layout-reset-button"),
  pollState: document.querySelector("#poll-state"),
  module01Status: document.querySelector("#module-01-status"),
  module02Status: document.querySelector("#module-02-status"),
  module03Status: document.querySelector("#module-03-status"),
  module04Status: document.querySelector("#module-04-status"),
  module05Status: document.querySelector("#module-05-status"),
  sensorStatus: document.querySelector("#sensor-status"),
  sensorSource: document.querySelector("#sensor-source"),
  fieldCount: document.querySelector("#field-count"),
  lastSampleAge: document.querySelector("#last-sample-age"),
  temperatureValue: document.querySelector("#temperature-value"),
  humidityValue: document.querySelector("#humidity-value"),
  co2Value: document.querySelector("#co2-value"),
  vocValue: document.querySelector("#voc-value"),
  comfortValue: document.querySelector("#comfort-value"),
  payloadPreview: document.querySelector("#payload-preview"),
  weatherLocation: document.querySelector("#weather-location"),
  weatherStatus: document.querySelector("#weather-status"),
  weatherSummary: document.querySelector("#weather-summary"),
  forecastList: document.querySelector("#forecast-list"),
  marketStatus: document.querySelector("#market-status"),
  marketNote: document.querySelector("#market-note"),
  marketUpdated: document.querySelector("#market-updated"),
  marketList: document.querySelector("#market-list"),
  marketSource: document.querySelector("#market-source"),
  lifeStatus: document.querySelector("#life-status"),
  lifeNote: document.querySelector("#life-note"),
  lifeSummary: document.querySelector("#life-summary"),
  yearProgressRing: document.querySelector("#year-progress-ring"),
  yearProgressValue: document.querySelector("#year-progress-value"),
  yearProgressNote: document.querySelector("#year-progress-note"),
  lifeProgressRing: document.querySelector("#life-progress-ring"),
  lifeProgressValue: document.querySelector("#life-progress-value"),
  lifeProgressNote: document.querySelector("#life-progress-note"),
  lifeFooter: document.querySelector("#life-footer"),
  lifeSettingsButton: document.querySelector("#life-settings-button"),
  lifeSettingsDialog: document.querySelector("#life-settings-dialog"),
  lifeSettingsForm: document.querySelector("#life-settings-form"),
  lifeBirthdateInput: document.querySelector("#life-birthdate-input"),
  lifeExpectancyInput: document.querySelector("#life-expectancy-input"),
  lifeSettingsCancel: document.querySelector("#life-settings-cancel"),
  wifiStatus: document.querySelector("#wifi-status"),
  wifiNote: document.querySelector("#wifi-note"),
  wifiSpeed: document.querySelector("#wifi-speed"),
  wifiLastCheck: document.querySelector("#wifi-last-check"),
  wifiSpeedtestButton: document.querySelector("#wifi-speedtest-button"),
  speedtestStatus: document.querySelector("#speedtest-status"),
  speedtestDownload: document.querySelector("#speedtest-download"),
  speedtestUpload: document.querySelector("#speedtest-upload"),
  speedtestPing: document.querySelector("#speedtest-ping"),
  speedtestRpm: document.querySelector("#speedtest-rpm")
};

state.lifeSettings = loadLifeSettings();

function getDashboardPanels() {
  return Array.from(elements.dashboard.querySelectorAll(".panel[data-module-id]"));
}

function getCurrentModuleOrder() {
  return getDashboardPanels().map((panel) => panel.dataset.moduleId);
}

function readStoredLayoutOrder() {
  try {
    const raw = window.localStorage.getItem(state.layoutStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch (error) {
    return [];
  }
}

function normaliseLayoutOrder(order) {
  const available = getCurrentModuleOrder();
  const availableSet = new Set(available);
  const seen = new Set();
  const merged = [];

  for (const moduleId of order) {
    if (!availableSet.has(moduleId) || seen.has(moduleId)) {
      continue;
    }

    seen.add(moduleId);
    merged.push(moduleId);
  }

  for (const moduleId of available) {
    if (seen.has(moduleId)) {
      continue;
    }

    seen.add(moduleId);
    merged.push(moduleId);
  }

  return merged;
}

function applyLayoutOrder(order) {
  const panels = new Map(getDashboardPanels().map((panel) => [panel.dataset.moduleId, panel]));

  for (const moduleId of order) {
    const panel = panels.get(moduleId);
    if (panel) {
      elements.dashboard.appendChild(panel);
    }
  }
}

function persistLayoutOrder() {
  try {
    window.localStorage.setItem(state.layoutStorageKey, JSON.stringify(getCurrentModuleOrder()));
  } catch (error) {
    return;
  }
}

function clearLayoutDragState() {
  for (const panel of getDashboardPanels()) {
    panel.classList.remove("panel--dragging", "panel--drop-before", "panel--drop-after");
  }
}

function activeDashboardColumnCount() {
  const template = window.getComputedStyle(elements.dashboard).gridTemplateColumns;
  return template.split(" ").filter((value) => value !== "").length || 1;
}

function inferDropPosition(target, event) {
  const rect = target.getBoundingClientRect();
  const columns = activeDashboardColumnCount();

  if (columns === 1) {
    return event.clientY < rect.top + (rect.height / 2) ? "before" : "after";
  }

  return event.clientX < rect.left + (rect.width / 2) ? "before" : "after";
}

function updateLayoutControls() {
  elements.dashboard.dataset.layoutEdit = state.layoutEdit ? "true" : "false";
  elements.layoutToggleButton.textContent = state.layoutEdit ? "Finish rearranging" : "Rearrange modules";
  elements.layoutToggleButton.setAttribute("aria-pressed", state.layoutEdit ? "true" : "false");
  elements.layoutResetButton.disabled = state.layoutEdit;

  for (const panel of getDashboardPanels()) {
    panel.draggable = state.layoutEdit;
  }
}

function setLayoutEdit(nextState) {
  state.layoutEdit = nextState;
  if (!nextState) {
    state.draggedModuleId = null;
    clearLayoutDragState();
  }

  updateLayoutControls();
}

function loadLifeSettings() {
  const defaults = {
    birthDate: "",
    lifeExpectancyYears: 85
  };

  try {
    const raw = window.localStorage.getItem(state.lifeSettingsStorageKey);
    if (!raw) {
      return defaults;
    }

    const parsed = JSON.parse(raw);
    const lifeExpectancyYears = Number.parseInt(parsed?.lifeExpectancyYears, 10);
    return {
      birthDate: typeof parsed?.birthDate === "string" ? parsed.birthDate : "",
      lifeExpectancyYears: Number.isFinite(lifeExpectancyYears) && lifeExpectancyYears > 0
        ? lifeExpectancyYears
        : defaults.lifeExpectancyYears
    };
  } catch (error) {
    return defaults;
  }
}

function persistLifeSettings(settings) {
  state.lifeSettings = settings;

  try {
    window.localStorage.setItem(state.lifeSettingsStorageKey, JSON.stringify(settings));
  } catch (error) {
    return;
  }
}

function loadSavedLayout() {
  const savedOrder = readStoredLayoutOrder();
  const order = normaliseLayoutOrder(savedOrder.length ? savedOrder : DEFAULT_LAYOUT_ORDER);
  applyLayoutOrder(order);
  persistLayoutOrder();
  updateLayoutControls();
}

function handlePanelDragStart(event) {
  if (!state.layoutEdit) {
    event.preventDefault();
    return;
  }

  const panel = event.currentTarget;
  state.draggedModuleId = panel.dataset.moduleId;
  clearLayoutDragState();
  panel.classList.add("panel--dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggedModuleId);
}

function handlePanelDragOver(event) {
  if (!state.layoutEdit || !state.draggedModuleId) {
    return;
  }

  const target = event.currentTarget;
  if (target.dataset.moduleId === state.draggedModuleId) {
    return;
  }

  event.preventDefault();
  clearLayoutDragState();
  const dragged = elements.dashboard.querySelector(`[data-module-id="${state.draggedModuleId}"]`);
  if (dragged) {
    dragged.classList.add("panel--dragging");
  }

  const position = inferDropPosition(target, event);
  target.classList.add(position === "before" ? "panel--drop-before" : "panel--drop-after");
}

function handlePanelDrop(event) {
  if (!state.layoutEdit || !state.draggedModuleId) {
    return;
  }

  event.preventDefault();
  const target = event.currentTarget;
  if (target.dataset.moduleId === state.draggedModuleId) {
    clearLayoutDragState();
    return;
  }

  const dragged = elements.dashboard.querySelector(`[data-module-id="${state.draggedModuleId}"]`);
  if (!dragged) {
    clearLayoutDragState();
    return;
  }

  const position = inferDropPosition(target, event);
  if (position === "before") {
    elements.dashboard.insertBefore(dragged, target);
  } else {
    elements.dashboard.insertBefore(dragged, target.nextSibling);
  }

  persistLayoutOrder();
  clearLayoutDragState();
}

function handlePanelDragEnd() {
  state.draggedModuleId = null;
  clearLayoutDragState();
}

function handleDashboardDrop(event) {
  if (!state.layoutEdit || !state.draggedModuleId || event.target !== elements.dashboard) {
    return;
  }

  event.preventDefault();
  const dragged = elements.dashboard.querySelector(`[data-module-id="${state.draggedModuleId}"]`);
  if (!dragged) {
    clearLayoutDragState();
    return;
  }

  elements.dashboard.appendChild(dragged);
  persistLayoutOrder();
  clearLayoutDragState();
}

function bindLayoutEditor() {
  for (const panel of getDashboardPanels()) {
    panel.addEventListener("dragstart", handlePanelDragStart);
    panel.addEventListener("dragover", handlePanelDragOver);
    panel.addEventListener("drop", handlePanelDrop);
    panel.addEventListener("dragend", handlePanelDragEnd);
  }

  elements.dashboard.addEventListener("dragover", (event) => {
    if (!state.layoutEdit || !state.draggedModuleId) {
      return;
    }

    event.preventDefault();
  });
  elements.dashboard.addEventListener("drop", handleDashboardDrop);
  elements.layoutToggleButton.addEventListener("click", () => {
    setLayoutEdit(!state.layoutEdit);
  });
  elements.layoutResetButton.addEventListener("click", () => {
    applyLayoutOrder(DEFAULT_LAYOUT_ORDER);
    persistLayoutOrder();
    setLayoutEdit(false);
  });
}

function setModuleStatus(element, online, label) {
  if (!element) {
    return;
  }

  element.classList.toggle("status-light--online", online);
  element.classList.toggle("status-light--offline", !online);
  element.classList.remove("status-light--sampling");
  element.setAttribute("aria-label", label);
}

function setModuleSampling(element, label) {
  if (!element) {
    return;
  }

  element.classList.remove("status-light--online", "status-light--offline");
  element.classList.add("status-light--sampling");
  element.setAttribute("aria-label", label);
}

function formatValue(value, suffix = "", digits = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return `${value.toFixed(digits)}${suffix}`;
}

function formatCurrency(value, currency = "USD") {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatPercentChange(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatCompactDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatAge(ms) {
  if (!ms && ms !== 0) {
    return "--";
  }

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}m:${String(seconds).padStart(2, "0")}s`;
}

function pickNumber(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

function extractTemperature(payload) {
  const explicitC = pickNumber(payload, ["temperature_c", "temp_c"]);
  if (explicitC != null) {
    return {
      celsius: explicitC,
      displayValue: explicitC,
      displayUnit: "C"
    };
  }

  const explicitF = pickNumber(payload, ["temperature_f", "temp_f"]);
  if (explicitF != null) {
    return {
      celsius: (explicitF - 32) * (5 / 9),
      displayValue: explicitF,
      displayUnit: "F"
    };
  }

  const generic = pickNumber(payload, ["temperature", "temp"]);
  if (generic == null) {
    return {
      celsius: null,
      displayValue: null,
      displayUnit: "C"
    };
  }

  const inferredFahrenheit = generic > 60;
  return {
    celsius: inferredFahrenheit ? (generic - 32) * (5 / 9) : generic,
    displayValue: generic,
    displayUnit: inferredFahrenheit ? "F" : "C"
  };
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function parseStoredDate(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  return isValidDate(parsed) ? parsed : null;
}

function addYears(date, years) {
  const next = new Date(date.getTime());
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function applyLifeRing(ring, valueElement, noteElement, progress, valueText, noteText, muted = false) {
  if (ring) {
    ring.style.setProperty("--progress", String(clamp(progress ?? 0, 0, 1)));
    ring.classList.toggle("life-ring--muted", muted);
  }

  if (valueElement) {
    valueElement.textContent = valueText;
    valueElement.classList.toggle("life-ring__value--small", valueText.length > 5);
  }

  if (noteElement) {
    noteElement.textContent = noteText;
  }
}

function computeComfortIndex(reading) {
  let score = 100;

  if (typeof reading.temperature === "number") {
    score -= Math.abs(reading.temperature - 22) * 2.2;
  }

  if (typeof reading.humidity === "number") {
    score -= Math.abs(reading.humidity - 45) * 0.9;
  }

  if (typeof reading.co2 === "number") {
    score -= Math.max(0, (reading.co2 - 700) / 18);
  }

  if (typeof reading.voc === "number") {
    score -= Math.max(0, (reading.voc - 150) / 10);
  }

  return clamp(Math.round(score), 0, 100);
}

function normaliseReading(payload) {
  const temperature = extractTemperature(payload);
  const humidity = pickNumber(payload, ["humidity", "humid", "hum"]);
  const co2 = pickNumber(payload, ["co2", "eco2"]);
  const voc = pickNumber(payload, ["voc", "tvoc"]);

  return {
    temperatureDisplay: temperature.displayValue,
    temperatureUnit: temperature.displayUnit,
    humidity,
    co2,
    voc,
    comfortIndex: computeComfortIndex({
      temperature: temperature.celsius,
      humidity,
      co2,
      voc
    }),
    fieldCount: Object.keys(payload || {}).length
  };
}

function mockPayload() {
  const now = Date.now();
  return {
    temperature_f: 72.2 + Math.sin(now / 240000) * 2.9,
    humidity: 46 + Math.cos(now / 180000) * 5.8,
    co2: 610 + Math.abs(Math.sin(now / 100000)) * 180,
    tvoc: 85 + Math.abs(Math.cos(now / 160000)) * 90,
    generated_at: new Date(now).toISOString(),
    source: "mock-fallback"
  };
}

function updateClock() {
  elements.clock.textContent = formatClock(new Date());
  elements.lastSampleAge.textContent = state.lastSensorAt
    ? `${formatAge(Date.now() - state.lastSensorAt)} ago`
    : "No data";
  renderLifeProgress();
}

function renderLifeProgress() {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearEnd = new Date(now.getFullYear() + 1, 0, 1);
  const yearProgress = clamp((now - yearStart) / (yearEnd - yearStart), 0, 1);
  const dayOfYear = Math.floor((now - yearStart) / 86400000) + 1;
  const totalDays = Math.round((yearEnd - yearStart) / 86400000);

  setModuleStatus(elements.module05Status, true, "Module 05 online");
  elements.lifeStatus.textContent = "Life progress tracker";
  elements.lifeNote.textContent = "Year progress and lifetime pacing";

  applyLifeRing(
    elements.yearProgressRing,
    elements.yearProgressValue,
    elements.yearProgressNote,
    yearProgress,
    `${Math.round(yearProgress * 100)}%`,
    `Day ${dayOfYear} of ${totalDays}`
  );

  const settings = state.lifeSettings;
  const expectancy = Number.isFinite(settings.lifeExpectancyYears) ? settings.lifeExpectancyYears : 85;
  const birthDate = parseStoredDate(settings.birthDate);

  if (!birthDate) {
    applyLifeRing(
      elements.lifeProgressRing,
      elements.lifeProgressValue,
      elements.lifeProgressNote,
      0,
      "Set DOB",
      `Assuming ${expectancy} year lifespan`,
      true
    );
    elements.lifeSummary.textContent = `Assuming ${expectancy} year lifespan`;
    elements.lifeFooter.textContent = "Open settings to add a birth date";
    return;
  }

  const endDate = addYears(birthDate, expectancy);
  const totalLifeMs = Math.max(endDate - birthDate, 1);
  const elapsedLifeMs = clamp(now - birthDate, 0, totalLifeMs);
  const lifeProgress = clamp(elapsedLifeMs / totalLifeMs, 0, 1);
  const ageYears = elapsedLifeMs / (365.2425 * 24 * 60 * 60 * 1000);

  applyLifeRing(
    elements.lifeProgressRing,
    elements.lifeProgressValue,
    elements.lifeProgressNote,
    lifeProgress,
    `${Math.round(lifeProgress * 100)}%`,
    `Age ${ageYears.toFixed(1)} of ${expectancy}`
  );
  elements.lifeSummary.textContent = `${formatCompactDate(birthDate)} to ${formatCompactDate(endDate)}`;
  elements.lifeFooter.textContent = `Life expectancy set to ${expectancy} years`;
}

function openLifeSettingsDialog() {
  const settings = state.lifeSettings;
  elements.lifeBirthdateInput.value = settings.birthDate || "";
  elements.lifeExpectancyInput.value = String(settings.lifeExpectancyYears || 85);

  if (typeof elements.lifeSettingsDialog.showModal === "function") {
    elements.lifeSettingsDialog.showModal();
    return;
  }

  elements.lifeSettingsDialog.setAttribute("open", "open");
}

function closeLifeSettingsDialog() {
  if (typeof elements.lifeSettingsDialog.close === "function") {
    elements.lifeSettingsDialog.close();
    return;
  }

  elements.lifeSettingsDialog.removeAttribute("open");
}

function handleLifeSettingsSubmit(event) {
  event.preventDefault();

  const expectancy = clamp(
    Number.parseInt(elements.lifeExpectancyInput.value, 10) || 85,
    1,
    130
  );

  persistLifeSettings({
    birthDate: elements.lifeBirthdateInput.value || "",
    lifeExpectancyYears: expectancy
  });
  closeLifeSettingsDialog();
  renderLifeProgress();
}

function renderSensorPayload(payload, reading, options = {}) {
  const isFallback = options.fallback === true;

  setModuleStatus(elements.module01Status, !isFallback, isFallback ? "Module 01 offline" : "Module 01 online");
  elements.sensorStatus.textContent = isFallback ? "Fallback sample active" : "ESP32 link active";
  elements.sensorSource.textContent = isFallback
    ? "Simulated data stream"
    : "Live payload proxied from 192.168.4.23";
  elements.fieldCount.textContent = String(reading.fieldCount);
  elements.temperatureValue.textContent = formatValue(
    reading.temperatureDisplay,
    ` ${reading.temperatureUnit}`
  );
  elements.humidityValue.textContent = formatValue(reading.humidity, " %");
  elements.co2Value.textContent = formatValue(reading.co2, " ppm", 0);
  elements.co2Value.classList.toggle(
    "detail-value--alert",
    typeof reading.co2 === "number" && reading.co2 >= 800
  );
  elements.co2Value.classList.toggle(
    "detail-value--positive",
    typeof reading.co2 === "number" && reading.co2 < 800
  );
  elements.vocValue.textContent = formatValue(reading.voc, " ppb", 0);
  elements.comfortValue.textContent = `${reading.comfortIndex} / 100`;
  elements.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  elements.pollState.textContent = "Dashboard active";
}

async function loadSensorData() {
  try {
    const response = await fetch(state.sensorEndpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const reading = normaliseReading(payload);
    state.lastSensorAt = Date.now();
    renderSensorPayload(payload, reading);
  } catch (error) {
    const payload = mockPayload();
    const reading = normaliseReading(payload);
    state.lastSensorAt = Date.now();
    renderSensorPayload(payload, reading, { fallback: true });
  }
}

function weatherCodeLabel(code) {
  const labels = {
    0: "Clear",
    1: "Mostly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Rain showers",
    82: "Heavy showers",
    85: "Snow showers",
    86: "Heavy snow",
    95: "Thunderstorm",
    96: "Storm and hail",
    99: "Severe storm"
  };

  return labels[code] || "Mixed conditions";
}

function formatDayLabel(isoDate, index) {
  if (!isoDate) {
    return "--";
  }

  if (index === 0) {
    return "Today";
  }

  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(isoDate));
}

function weatherAlertClass(...temperatures) {
  return temperatures.some((temperature) => typeof temperature === "number" && temperature > 90)
    ? " weather-alert"
    : "";
}

function marketChangeClass(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }

  if (value > 0) {
    return " market-row__change--positive market-sparkline--positive";
  }

  if (value < 0) {
    return " market-row__change--negative market-sparkline--negative";
  }

  return "";
}

function buildMarketSparkline(points) {
  const values = Array.isArray(points)
    ? points.filter((value) => typeof value === "number" && Number.isFinite(value))
    : [];

  if (!values.length) {
    return '<div class="market-sparkline market-sparkline--empty"></div>';
  }

  const visible = values.slice(-24);
  const low = Math.min(...visible);
  const high = Math.max(...visible);
  const range = Math.max(high - low, 1);
  const bars = visible.map((value) => {
    const height = 18 + (((value - low) / range) * 82);
    return `<span style="height:${height.toFixed(1)}%"></span>`;
  }).join("");

  return `<div class="market-sparkline">${bars}</div>`;
}

function renderMarketPayload(payload) {
  const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
  if (!symbols.length) {
    renderMarketError("No market symbols returned");
    return;
  }

  setModuleStatus(elements.module04Status, true, "Module 04 online");
  elements.marketStatus.textContent = "Daily market watch";
  elements.marketNote.textContent = "SPY / QQQ / SOXL / CL=F / Bitcoin";
  elements.marketUpdated.textContent = payload.sampled_at
    ? `Updated / ${formatClock(new Date(payload.sampled_at * 1000))}`
    : `Updated / ${formatClock(new Date())}`;
  elements.marketSource.textContent = payload.partial
    ? `${payload.source || "Market feed"} / partial update`
    : `${payload.source || "Market feed"} / 1D intraday`;

  const rows = symbols.map((item) => {
    const changeClass = marketChangeClass(item.percent_change);
    const label = item.label || item.symbol || "--";
    const symbol = item.symbol || "--";
    const price = formatCurrency(item.price, item.currency || "USD");
    const change = formatPercentChange(item.percent_change);
    const sparkline = buildMarketSparkline(item.points);

    return `
      <article class="market-row">
        <div class="market-row__top">
          <div class="market-row__identity">
            <span class="market-row__symbol">${label}</span>
            <span class="market-row__price">${symbol} / ${price}</span>
          </div>
          <span class="market-row__change${changeClass}">${change}</span>
        </div>
        <div class="market-row__chart${changeClass}">
          ${sparkline}
        </div>
      </article>
    `;
  });

  elements.marketList.innerHTML = rows.join("");
}

function renderMarketError(message) {
  setModuleStatus(elements.module04Status, false, "Module 04 offline");
  elements.marketStatus.textContent = "Market feed unavailable";
  elements.marketNote.textContent = message;
  elements.marketUpdated.textContent = `Failed / ${formatClock(new Date())}`;
  elements.marketSource.textContent = "Market data unavailable";
  elements.marketList.innerHTML = `<div class="market-empty">${message}</div>`;
}

async function loadMarkets() {
  try {
    const response = await fetch(state.marketEndpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error || "Market request failed");
    }

    renderMarketPayload(payload);
  } catch (error) {
    renderMarketError("Market service unavailable");
  }
}

function renderWeatherForecast(daily) {
  const times = daily?.time || [];
  const maxTemps = daily?.temperature_2m_max || [];
  const minTemps = daily?.temperature_2m_min || [];
  const weatherCodes = daily?.weather_code || [];
  const rainChance = daily?.precipitation_probability_max || [];

  if (!times.length) {
    elements.forecastList.innerHTML = '<div class="forecast-empty">Forecast unavailable</div>';
    return;
  }

  const rows = times.map((date, index) => {
    const day = formatDayLabel(date, index);
    const description = weatherCodeLabel(weatherCodes[index]);
    const highValue = maxTemps[index];
    const lowValue = minTemps[index];
    const high = formatValue(maxTemps[index], "F", 0);
    const low = formatValue(minTemps[index], "F", 0);
    const rain = typeof rainChance[index] === "number" ? `${Math.round(rainChance[index])}%` : "--";

    return `
      <article class="forecast-row">
        <span class="forecast-day">${day}</span>
        <span class="forecast-desc">${description}</span>
        <span class="forecast-temps${weatherAlertClass(highValue, lowValue)}">H ${high} / L ${low}</span>
        <span class="forecast-rain">Rain ${rain}</span>
      </article>
    `;
  });

  elements.forecastList.innerHTML = rows.join("");
}

function renderWeatherError(message) {
  setModuleStatus(elements.module02Status, false, "Module 02 offline");
  elements.weatherStatus.textContent = message;
  elements.weatherSummary.textContent = "Forecast unavailable";
  elements.forecastList.innerHTML = `<div class="forecast-empty">${message}</div>`;
}

function updateWeatherLocation(position) {
  const { latitude, longitude } = position.coords;
  elements.weatherLocation.textContent = "Current location";
  elements.weatherStatus.textContent = `Lat ${latitude.toFixed(2)} / Lon ${longitude.toFixed(2)}`;
}

async function loadWeather(lat, lon) {
  const query = new URLSearchParams({
    lat: String(lat),
    lon: String(lon)
  });

  const response = await fetch(`${state.weatherEndpoint}?${query.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  const daily = payload.daily;
  const currentTemp = payload.current?.temperature_2m ?? payload.current_weather?.temperature;

  setModuleStatus(elements.module02Status, true, "Module 02 online");
  elements.weatherSummary.textContent = currentTemp != null
    ? formatValue(currentTemp, "F", 0)
    : "--";
  elements.weatherSummary.classList.toggle(
    "weather-alert",
    typeof currentTemp === "number" && currentTemp > 90
  );
  elements.weatherStatus.textContent = `Forecast loaded / ${formatClock(new Date())}`;
  renderWeatherForecast(daily);
}

function renderWifiError(message) {
  setModuleStatus(elements.module03Status, false, "Module 03 offline");
  elements.wifiStatus.textContent = "Speed test unavailable";
  elements.wifiNote.textContent = message;
  elements.wifiSpeed.textContent = "--";
  elements.wifiLastCheck.textContent = `Failed ${formatClock(new Date())}`;
}

function setSpeedtestButtonState(running) {
  state.speedtestRunning = running;
  elements.wifiSpeedtestButton.disabled = running;
  elements.wifiSpeedtestButton.textContent = running ? "Running..." : "Run speed test";
}

function renderSpeedtestError(message) {
  setModuleStatus(elements.module03Status, false, "Module 03 offline");
  elements.wifiStatus.textContent = "Speed test unavailable";
  elements.wifiNote.textContent = message;
  elements.wifiSpeed.textContent = "--";
  elements.speedtestStatus.textContent = message;
  elements.speedtestDownload.textContent = "--";
  elements.speedtestUpload.textContent = "--";
  elements.speedtestPing.textContent = "--";
  elements.speedtestPing.classList.remove("detail-value--positive");
  elements.speedtestRpm.textContent = "--";
  elements.wifiLastCheck.textContent = `Failed ${formatClock(new Date())}`;
}

function renderSpeedtestPayload(payload) {
  setModuleStatus(elements.module03Status, true, "Module 03 online");
  elements.wifiStatus.textContent = "Speed test complete";
  elements.wifiNote.textContent = payload.interface
    ? `${String(payload.interface).toUpperCase()} / NETWORK QUALITY`
    : "NETWORK QUALITY";
  elements.wifiSpeed.textContent = formatValue(payload.download_mbps, " Mbps", 1);
  elements.speedtestStatus.textContent = payload.tested_at
    ? `Completed / ${payload.tested_at}`
    : "Completed";
  elements.speedtestDownload.textContent = formatValue(payload.download_mbps, " Mbps", 1);
  elements.speedtestUpload.textContent = formatValue(payload.upload_mbps, " Mbps", 1);
  elements.speedtestPing.textContent = formatValue(payload.latency_ms, " ms", 0);
  elements.speedtestPing.classList.toggle(
    "detail-value--positive",
    typeof payload.latency_ms === "number" && payload.latency_ms < 50
  );
  elements.speedtestRpm.textContent = payload.responsiveness_rpm != null
    ? `${Math.round(payload.responsiveness_rpm)} rpm`
    : "--";
  elements.wifiLastCheck.textContent = payload.tested_at
    ? `Completed ${payload.tested_at}`
    : `Completed ${formatClock(new Date())}`;
}

async function runWifiSpeedtest() {
  if (state.speedtestRunning) {
    return;
  }

  setSpeedtestButtonState(true);
  elements.speedtestStatus.textContent = "Running networkQuality test";
  setModuleSampling(elements.module03Status, "Module 03 speed test running");
  elements.wifiStatus.textContent = "Running speed test";
  elements.wifiNote.textContent = "This may take a few seconds";

  try {
    const response = await fetch(state.wifiSpeedtestEndpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error || "Speed test failed");
    }

    renderSpeedtestPayload(payload);
  } catch (error) {
    renderSpeedtestError("Speed test unavailable");
  } finally {
    setSpeedtestButtonState(false);
  }
}

function requestWeather() {
  if (!("geolocation" in navigator)) {
    renderWeatherError("Geolocation unavailable in this browser");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      updateWeatherLocation(position);

      try {
        await loadWeather(position.coords.latitude, position.coords.longitude);
      } catch (error) {
        renderWeatherError("Weather service unavailable");
      }
    },
    (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        renderWeatherError("Location access denied");
        return;
      }

      renderWeatherError("Unable to determine location");
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 900000
    }
  );
}

function startPolling() {
  clearInterval(state.sensorTimer);
  clearInterval(state.marketTimer);
  clearInterval(state.weatherTimer);
  state.sensorTimer = window.setInterval(loadSensorData, state.sensorRefreshMs);
  state.marketTimer = window.setInterval(loadMarkets, state.marketRefreshMs);
  state.weatherTimer = window.setInterval(requestWeather, state.weatherRefreshMs);
}

bindLayoutEditor();
loadSavedLayout();

elements.wifiSpeedtestButton.addEventListener("click", () => {
  runWifiSpeedtest();
});
elements.lifeSettingsButton.addEventListener("click", () => {
  openLifeSettingsDialog();
});
elements.lifeSettingsCancel.addEventListener("click", () => {
  closeLifeSettingsDialog();
});
elements.lifeSettingsForm.addEventListener("submit", handleLifeSettingsSubmit);

updateClock();
window.setInterval(updateClock, 1000);
loadSensorData();
loadMarkets();
requestWeather();
runWifiSpeedtest();
startPolling();

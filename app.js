const config = window.SITUATION_MONITOR_CONFIG || {};

const state = {
  sensorRefreshMs: config.refreshMs || 5000,
  weatherRefreshMs: config.weatherRefreshMs || 1800000,
  sensorEndpoint: config.endpoint || "/api/air",
  weatherEndpoint: config.weatherEndpoint || "/api/weather",
  wifiSpeedtestEndpoint: config.wifiSpeedtestEndpoint || "/api/wifi-speedtest",
  lastSensorAt: null,
  speedtestRunning: false,
  sensorTimer: null,
  weatherTimer: null
};

const elements = {
  clock: document.querySelector("#clock"),
  pollState: document.querySelector("#poll-state"),
  module01Status: document.querySelector("#module-01-status"),
  module02Status: document.querySelector("#module-02-status"),
  module03Status: document.querySelector("#module-03-status"),
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

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
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
  elements.vocValue.textContent = formatValue(reading.voc, " ppb", 0);
  elements.comfortValue.textContent = `${reading.comfortIndex} / 100`;
  elements.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  elements.pollState.textContent = isFallback ? "Fallback sample displayed" : "Air monitor panel live";
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
  clearInterval(state.weatherTimer);
  state.sensorTimer = window.setInterval(loadSensorData, state.sensorRefreshMs);
  state.weatherTimer = window.setInterval(requestWeather, state.weatherRefreshMs);
}

elements.wifiSpeedtestButton.addEventListener("click", () => {
  runWifiSpeedtest();
});

updateClock();
window.setInterval(updateClock, 1000);
loadSensorData();
requestWeather();
runWifiSpeedtest();
startPolling();

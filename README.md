# Situation Monitor

A lightweight local dashboard for house sensors with a monochrome terminal-style interface.

## Run it

```bash
python3 server.py
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Sensor endpoint

The dashboard proxies your ESP32 feed through `/api/air` to avoid browser cross-origin issues.

Default upstream:

```text
http://192.168.4.23/data
```

Override it if needed:

```bash
SITUATION_SENSOR_URL="http://192.168.4.23/data" python3 server.py
```

## Weather module

The weekly forecast panel uses browser geolocation and proxies forecast requests through `/api/weather`.

- The browser will ask for location access on `localhost`.
- Weather data is fetched from Open-Meteo with a 7-day forecast in Fahrenheit.
- If location access is denied or the service is unavailable, the panel shows a styled fallback message instead of breaking layout.

## Notes

- The frontend accepts flexible JSON shapes and looks for common air-quality keys such as `temperature`, `humidity`, `pm25`, `co2`, `voc`, `aqi`, and `rssi`.
- If the sensor is unavailable, the UI drops to a simulated fallback stream so the layout stays usable while you wire hardware in.
- Additional reserved modules remain in place for future scrapes, utilities, or automation summaries.

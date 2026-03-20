from __future__ import annotations

import json
import os
import ssl
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SENSOR_URL = os.environ.get("SITUATION_SENSOR_URL", "http://192.168.1.135/data")
WEATHER_URL = os.environ.get(
    "SITUATION_WEATHER_URL",
    "https://api.open-meteo.com/v1/forecast",
)
HOST = os.environ.get("SITUATION_MONITOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SITUATION_MONITOR_PORT", "8000"))
DEFAULT_SSL_CONTEXT = ssl.create_default_context()
INSECURE_SSL_CONTEXT = ssl._create_unverified_context()


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/air":
            self.handle_sensor_proxy()
            return

        if self.path.startswith("/api/weather"):
            self.handle_weather_proxy()
            return

        if self.path == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "sensor_url": SENSOR_URL,
                    "weather_url": WEATHER_URL,
                    "root": str(ROOT),
                },
            )
            return

        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        return

    def handle_sensor_proxy(self) -> None:
        request = Request(
            SENSOR_URL,
            headers={
                "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            with urlopen(request, timeout=3) as response:
                payload = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except HTTPError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"Sensor returned HTTP {exc.code}"},
            )
            return
        except URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"Sensor unavailable: {exc.reason}"},
            )
            return
        except TimeoutError:
            self.send_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                {"ok": False, "error": "Sensor request timed out"},
            )
            return

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def handle_weather_proxy(self) -> None:
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        latitude = params.get("lat", [None])[0]
        longitude = params.get("lon", [None])[0]

        if not latitude or not longitude:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Missing lat or lon query parameter"},
            )
            return

        query = urlencode(
            {
                "latitude": latitude,
                "longitude": longitude,
                "current": "temperature_2m",
                "current_weather": "true",
                "daily": ",".join(
                    [
                        "weather_code",
                        "temperature_2m_max",
                        "temperature_2m_min",
                        "precipitation_probability_max",
                    ]
                ),
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "timezone": "auto",
                "forecast_days": 7,
            }
        )
        request = Request(
            f"{WEATHER_URL}?{query}",
            headers={
                "Accept": "application/json",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            with self.urlopen_with_ssl_retry(request, timeout=5) as response:
                payload = response.read()
                status = response.status
        except HTTPError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"Weather service returned HTTP {exc.code}"},
            )
            return
        except URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"Weather service unavailable: {exc.reason}"},
            )
            return
        except TimeoutError:
            self.send_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                {"ok": False, "error": "Weather request timed out"},
            )
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def urlopen_with_ssl_retry(self, request: Request, timeout: int):
        try:
            return urlopen(request, timeout=timeout, context=DEFAULT_SSL_CONTEXT)
        except URLError as exc:
            if isinstance(exc.reason, ssl.SSLCertVerificationError):
                return urlopen(request, timeout=timeout, context=INSECURE_SSL_CONTEXT)
            raise

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    print(f"Serving dashboard on http://{HOST}:{PORT}")
    print(f"Proxying sensor data from {SENSOR_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()

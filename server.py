from __future__ import annotations

import json
import os
import ssl
import subprocess
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SENSOR_URL = os.environ.get("SITUATION_SENSOR_URL", "http://192.168.4.23/data")
WEATHER_URL = os.environ.get(
    "SITUATION_WEATHER_URL",
    "https://api.open-meteo.com/v1/forecast",
)
HOST = os.environ.get("SITUATION_MONITOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SITUATION_MONITOR_PORT", "8000"))
DEFAULT_SSL_CONTEXT = ssl.create_default_context()
INSECURE_SSL_CONTEXT = ssl._create_unverified_context()
WIFI_SAMPLE = {
    "interface": None,
    "timestamp": None,
    "rx_bytes": None,
    "tx_bytes": None,
}
SPEEDTEST_STATE = {
    "running": False,
}


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

        if self.path == "/api/wifi":
            self.handle_wifi_proxy()
            return

        if self.path == "/api/wifi-speedtest":
            self.handle_wifi_speedtest()
            return

        if self.path == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "sensor_url": SENSOR_URL,
                    "weather_url": WEATHER_URL,
                    "wifi_endpoint": "/api/wifi",
                    "wifi_speedtest_endpoint": "/api/wifi-speedtest",
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

    def handle_wifi_proxy(self) -> None:
        self.send_json(HTTPStatus.OK, self.collect_wifi_metrics())

    def handle_wifi_speedtest(self) -> None:
        if SPEEDTEST_STATE["running"]:
            self.send_json(
                HTTPStatus.CONFLICT,
                {"ok": False, "error": "A speed test is already running"},
            )
            return

        SPEEDTEST_STATE["running"] = True
        try:
            payload = self.run_network_quality_test()
            self.send_json(HTTPStatus.OK, payload)
        finally:
            SPEEDTEST_STATE["running"] = False

    def collect_wifi_metrics(self) -> dict:
        interface = self.detect_active_interface()
        if not interface:
            return {"ok": False, "online": False, "error": "No active network interface found"}

        details = self.read_ifconfig_details(interface)
        counters = self.read_interface_counters(interface)
        if not counters:
            return {
                "ok": False,
                "online": details["status"] == "active",
                "interface": interface,
                "ip_address": details["ip_address"],
                "error": "Unable to read network counters",
            }

        now = time.time()
        rx_mbps = None
        tx_mbps = None
        sampling = True

        if (
            WIFI_SAMPLE["interface"] == interface
            and WIFI_SAMPLE["timestamp"] is not None
            and WIFI_SAMPLE["rx_bytes"] is not None
            and WIFI_SAMPLE["tx_bytes"] is not None
        ):
            elapsed = now - WIFI_SAMPLE["timestamp"]
            if elapsed > 0:
                rx_delta = max(0, counters["rx_bytes"] - WIFI_SAMPLE["rx_bytes"])
                tx_delta = max(0, counters["tx_bytes"] - WIFI_SAMPLE["tx_bytes"])
                rx_mbps = (rx_delta * 8) / elapsed / 1_000_000
                tx_mbps = (tx_delta * 8) / elapsed / 1_000_000
                sampling = False

        WIFI_SAMPLE.update(
            {
                "interface": interface,
                "timestamp": now,
                "rx_bytes": counters["rx_bytes"],
                "tx_bytes": counters["tx_bytes"],
            }
        )

        return {
            "ok": True,
            "online": details["status"] == "active",
            "sampling": sampling,
            "interface": interface,
            "ip_address": details["ip_address"],
            "rx_mbps": rx_mbps,
            "tx_mbps": tx_mbps,
            "sampled_at": now,
        }

    def run_network_quality_test(self) -> dict:
        interface = self.detect_active_interface()
        command = ["networkQuality", "-c", "-M", "15"]
        if interface:
            command.extend(["-I", interface])

        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return {
                "ok": False,
                "error": result.stderr.strip() or "networkQuality failed",
            }

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "error": "Unable to parse networkQuality output",
            }

        download_bps = payload.get("dl_throughput")
        upload_bps = payload.get("ul_throughput")
        base_rtt = payload.get("base_rtt")
        responsiveness = payload.get("responsiveness")

        return {
            "ok": True,
            "interface": payload.get("interface_name") or interface,
            "download_mbps": (download_bps / 1_000_000) if isinstance(download_bps, (int, float)) else None,
            "upload_mbps": (upload_bps / 1_000_000) if isinstance(upload_bps, (int, float)) else None,
            "latency_ms": base_rtt,
            "responsiveness_rpm": responsiveness,
            "tested_at": payload.get("end_date"),
        }

    def detect_active_interface(self) -> str | None:
        result = subprocess.run(
            ["ifconfig"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None

        current_name = None
        current_lines: list[str] = []
        chosen = None

        def maybe_pick(name: str | None, lines: list[str]) -> str | None:
            if not name or name.startswith(("lo", "awdl", "llw", "utun", "bridge")):
                return None
            has_active = any("status: active" in line for line in lines)
            has_ipv4 = any(line.strip().startswith("inet ") and "127.0.0.1" not in line for line in lines)
            return name if has_active and has_ipv4 else None

        for line in result.stdout.splitlines():
            if line and not line[0].isspace():
                candidate = maybe_pick(current_name, current_lines)
                if candidate:
                    chosen = candidate
                    break
                current_name = line.split(":", 1)[0]
                current_lines = []
            else:
                current_lines.append(line)

        if not chosen:
            chosen = maybe_pick(current_name, current_lines)

        return chosen

    def read_ifconfig_details(self, interface: str) -> dict:
        result = subprocess.run(
            ["ifconfig", interface],
            capture_output=True,
            text=True,
            check=False,
        )
        ip_address = None
        status = "inactive"

        if result.returncode == 0:
            for line in result.stdout.splitlines():
                stripped = line.strip()
                if stripped.startswith("inet ") and "127.0.0.1" not in stripped:
                    parts = stripped.split()
                    if len(parts) >= 2:
                        ip_address = parts[1]
                if stripped.startswith("status:"):
                    status = stripped.split(":", 1)[1].strip()

        return {"ip_address": ip_address, "status": status}

    def read_interface_counters(self, interface: str) -> dict | None:
        result = subprocess.run(
            ["netstat", "-bI", interface],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None

        for line in result.stdout.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("Name "):
                continue
            if not stripped.startswith(interface):
                continue

            parts = stripped.split()
            if len(parts) < 10:
                continue

            try:
                return {
                    "rx_bytes": int(parts[6]),
                    "tx_bytes": int(parts[9]),
                }
            except ValueError:
                continue

        return None

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

from __future__ import annotations

import json
import os
import platform
import shutil
import ssl
import subprocess
import time
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SENSOR_URL = os.environ.get("SITUATION_SENSOR_URL", "http://airmonitor.local/data")
WEATHER_URL = os.environ.get(
    "SITUATION_WEATHER_URL",
    "https://api.open-meteo.com/v1/forecast",
)
MARKET_URL = os.environ.get(
    "SITUATION_MARKET_URL",
    "https://query1.finance.yahoo.com/v8/finance/chart",
)
MARKET_URLS = list(
    dict.fromkeys(
        [
            MARKET_URL,
            "https://query2.finance.yahoo.com/v8/finance/chart",
        ]
    )
)
CAMERA_URL = os.environ.get("SITUATION_CAMERA_URL", "http://camera.local/")
CAMERA_MOTION_URL = os.environ.get(
    "SITUATION_CAMERA_MOTION_URL",
    f"{CAMERA_URL.rstrip('/')}/motion",
)
HOST = os.environ.get("SITUATION_MONITOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SITUATION_MONITOR_PORT", "8000"))
SPEEDTEST_DOWNLOAD_URL = os.environ.get(
    "SITUATION_SPEEDTEST_DOWNLOAD_URL",
    "https://speed.cloudflare.com/__down",
)
SPEEDTEST_UPLOAD_URL = os.environ.get(
    "SITUATION_SPEEDTEST_UPLOAD_URL",
    "https://speed.cloudflare.com/__up",
)
SPEEDTEST_DOWNLOAD_BYTES = int(os.environ.get("SITUATION_SPEEDTEST_DOWNLOAD_BYTES", "10000000"))
SPEEDTEST_UPLOAD_BYTES = int(os.environ.get("SITUATION_SPEEDTEST_UPLOAD_BYTES", "5000000"))
DEFAULT_SSL_CONTEXT = ssl.create_default_context()
INSECURE_SSL_CONTEXT = ssl._create_unverified_context()
MARKET_SYMBOLS = [
    {"symbol": "SPY", "label": "SPY"},
    {"symbol": "QQQ", "label": "QQQ"},
    {"symbol": "SOXL", "label": "SOXL"},
    {"symbol": "CL=F", "label": "CL=F"},
    {"symbol": "BTC-USD", "label": "Bitcoin"},
]
WIFI_SAMPLE = {
    "interface": None,
    "timestamp": None,
    "rx_bytes": None,
    "tx_bytes": None,
}
SPEEDTEST_STATE = {
    "running": False,
}
MARKET_CACHE = {
    "payload": None,
}


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        request_path = urlparse(self.path).path
        if request_path == "/" or request_path.startswith("/index.html") or request_path.endswith(".js") or request_path.endswith(".css"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/air":
            self.handle_sensor_proxy()
            return

        if self.path.startswith("/api/weather"):
            self.handle_weather_proxy()
            return

        if self.path == "/api/markets":
            self.handle_markets_proxy()
            return

        if self.path == "/api/camera-health":
            self.handle_camera_health()
            return

        if self.path == "/api/camera-motion":
            self.handle_camera_motion()
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
                    "markets_endpoint": "/api/markets",
                    "market_urls": MARKET_URLS,
                    "camera_url": CAMERA_URL,
                    "camera_health_endpoint": "/api/camera-health",
                    "camera_motion_url": CAMERA_MOTION_URL,
                    "camera_motion_endpoint": "/api/camera-motion",
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

    def handle_camera_health(self) -> None:
        request = Request(
            CAMERA_URL,
            headers={
                "Accept": "text/html,image/*;q=0.9,*/*;q=0.8",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            with urlopen(request, timeout=3) as response:
                status = response.status
        except HTTPError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "online": False, "error": f"Camera returned HTTP {exc.code}"},
            )
            return
        except URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "online": False, "error": f"Camera unavailable: {exc.reason}"},
            )
            return
        except TimeoutError:
            self.send_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                {"ok": False, "online": False, "error": "Camera request timed out"},
            )
            return

        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "online": True,
                "status": status,
                "camera_url": CAMERA_URL,
                "checked_at": int(time.time()),
            },
        )

    def handle_camera_motion(self) -> None:
        request = Request(
            CAMERA_MOTION_URL,
            headers={
                "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            with urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "motion_available": False, "error": f"Camera motion returned HTTP {exc.code}"},
            )
            return
        except URLError as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "motion_available": False, "error": f"Camera motion unavailable: {exc.reason}"},
            )
            return
        except (TimeoutError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "motion_available": False, "error": f"Camera motion error: {exc}"},
            )
            return

        payload["motion_available"] = True
        self.send_json(HTTPStatus.OK, payload)

    def handle_markets_proxy(self) -> None:
        quotes = []
        errors = []

        for item in MARKET_SYMBOLS:
            try:
                quotes.append(self.fetch_market_quote(item))
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
                errors.append(f"{item['symbol']}: {exc}")

        if not quotes:
            cached_payload = MARKET_CACHE.get("payload")
            if cached_payload:
                stale_payload = dict(cached_payload)
                stale_payload["stale"] = True
                stale_payload["partial"] = True
                stale_payload["errors"] = errors[:3]
                self.send_json(HTTPStatus.OK, stale_payload)
                return

            self.send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": "Market data unavailable", "details": errors},
            )
            return

        payload = {
            "ok": True,
            "source": "Yahoo Finance",
            "sampled_at": int(time.time()),
            "symbols": quotes,
            "partial": bool(errors),
            "errors": errors[:3],
        }
        MARKET_CACHE["payload"] = payload
        self.send_json(HTTPStatus.OK, payload)

    def handle_wifi_speedtest(self) -> None:
        if SPEEDTEST_STATE["running"]:
            self.send_json(
                HTTPStatus.CONFLICT,
                {"ok": False, "error": "A speed test is already running"},
            )
            return

        SPEEDTEST_STATE["running"] = True
        try:
            payload = self.run_wifi_speedtest()
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

        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "networkQuality timed out"}

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
            "source": "networkQuality",
            "interface": payload.get("interface_name") or interface,
            "download_mbps": (download_bps / 1_000_000) if isinstance(download_bps, (int, float)) else None,
            "upload_mbps": (upload_bps / 1_000_000) if isinstance(upload_bps, (int, float)) else None,
            "latency_ms": base_rtt,
            "responsiveness_rpm": responsiveness,
            "tested_at": payload.get("end_date"),
        }

    def run_wifi_speedtest(self) -> dict:
        attempts = []

        if platform.system() == "Darwin" and shutil.which("networkQuality"):
            attempts.append(("networkQuality", self.run_network_quality_test))

        if shutil.which("speedtest"):
            attempts.append(("Ookla speedtest CLI", self.run_ookla_speedtest))

        if shutil.which("speedtest-cli"):
            attempts.append(("speedtest-cli", self.run_speedtest_cli))

        attempts.append(("HTTP fallback", self.run_http_speedtest))

        errors = []
        for source, runner in attempts:
            payload = runner()
            if payload.get("ok"):
                return payload
            errors.append(f"{source}: {payload.get('error', 'failed')}")

        return {
            "ok": False,
            "error": "No speed test backend completed successfully",
            "details": errors,
        }

    def run_ookla_speedtest(self) -> dict:
        result = self.run_command(
            ["speedtest", "--format=json", "--accept-license", "--accept-gdpr"],
            timeout=120,
        )
        if result["error"]:
            return {"ok": False, "error": result["error"]}

        try:
            payload = json.loads(result["stdout"])
        except json.JSONDecodeError:
            return {"ok": False, "error": "Unable to parse speedtest output"}

        download = payload.get("download") or {}
        upload = payload.get("upload") or {}
        ping = payload.get("ping") or {}
        interface = payload.get("interface") or {}

        download_bandwidth = download.get("bandwidth")
        upload_bandwidth = upload.get("bandwidth")

        return {
            "ok": True,
            "source": "Ookla speedtest CLI",
            "interface": interface.get("name") or interface.get("externalIp") or self.detect_active_interface(),
            "download_mbps": self.bytes_per_second_to_mbps(download_bandwidth),
            "upload_mbps": self.bytes_per_second_to_mbps(upload_bandwidth),
            "latency_ms": ping.get("latency"),
            "responsiveness_rpm": None,
            "tested_at": payload.get("timestamp") or self.current_timestamp(),
        }

    def run_speedtest_cli(self) -> dict:
        result = self.run_command(["speedtest-cli", "--json"], timeout=120)
        if result["error"]:
            return {"ok": False, "error": result["error"]}

        try:
            payload = json.loads(result["stdout"])
        except json.JSONDecodeError:
            return {"ok": False, "error": "Unable to parse speedtest-cli output"}

        return {
            "ok": True,
            "source": "speedtest-cli",
            "interface": self.detect_active_interface(),
            "download_mbps": self.bits_per_second_to_mbps(payload.get("download")),
            "upload_mbps": self.bits_per_second_to_mbps(payload.get("upload")),
            "latency_ms": payload.get("ping"),
            "responsiveness_rpm": None,
            "tested_at": payload.get("timestamp") or self.current_timestamp(),
        }

    def run_http_speedtest(self) -> dict:
        download_result = self.measure_download_speed()
        if not download_result["ok"]:
            return {"ok": False, "error": download_result["error"]}

        upload_result = self.measure_upload_speed()
        latency_ms = self.measure_latency()

        return {
            "ok": True,
            "source": "HTTP fallback",
            "interface": self.detect_active_interface(),
            "download_mbps": download_result["mbps"],
            "upload_mbps": upload_result["mbps"] if upload_result["ok"] else None,
            "latency_ms": latency_ms,
            "responsiveness_rpm": None,
            "tested_at": self.current_timestamp(),
            "partial": not upload_result["ok"],
            "warning": None if upload_result["ok"] else upload_result["error"],
        }

    def measure_download_speed(self) -> dict:
        url = f"{SPEEDTEST_DOWNLOAD_URL}?{urlencode({'bytes': SPEEDTEST_DOWNLOAD_BYTES})}"
        request = Request(
            url,
            headers={
                "Accept": "application/octet-stream",
                "Accept-Encoding": "identity",
                "Cache-Control": "no-store",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            start = time.perf_counter()
            total_bytes = 0
            with self.urlopen_with_ssl_retry(request, timeout=30) as response:
                while True:
                    chunk = response.read(1024 * 128)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
            elapsed = time.perf_counter() - start
        except (HTTPError, URLError, TimeoutError) as exc:
            return {"ok": False, "error": f"Download test failed: {exc}"}

        if elapsed <= 0 or total_bytes <= 0:
            return {"ok": False, "error": "Download test returned no data"}

        return {"ok": True, "mbps": (total_bytes * 8) / elapsed / 1_000_000}

    def measure_upload_speed(self) -> dict:
        data = os.urandom(SPEEDTEST_UPLOAD_BYTES)
        request = Request(
            SPEEDTEST_UPLOAD_URL,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(data)),
                "Cache-Control": "no-store",
                "User-Agent": "SituationMonitor/1.0",
            },
        )

        try:
            start = time.perf_counter()
            with self.urlopen_with_ssl_retry(request, timeout=30) as response:
                response.read()
            elapsed = time.perf_counter() - start
        except (HTTPError, URLError, TimeoutError) as exc:
            return {"ok": False, "error": f"Upload test failed: {exc}"}

        if elapsed <= 0:
            return {"ok": False, "error": "Upload test completed too quickly to measure"}

        return {"ok": True, "mbps": (len(data) * 8) / elapsed / 1_000_000}

    def measure_latency(self) -> float | None:
        timings = []
        url = f"{SPEEDTEST_DOWNLOAD_URL}?{urlencode({'bytes': 1})}"

        for _ in range(3):
            request = Request(
                url,
                headers={
                    "Accept": "application/octet-stream",
                    "Cache-Control": "no-store",
                    "User-Agent": "SituationMonitor/1.0",
                },
            )

            try:
                start = time.perf_counter()
                with self.urlopen_with_ssl_retry(request, timeout=10) as response:
                    response.read()
                timings.append((time.perf_counter() - start) * 1000)
            except (HTTPError, URLError, TimeoutError):
                continue

        if not timings:
            return None

        return sum(timings) / len(timings)

    def run_command(self, command: list[str], timeout: int) -> dict:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout,
            )
        except (FileNotFoundError, PermissionError) as exc:
            return {"stdout": "", "error": str(exc)}
        except subprocess.TimeoutExpired:
            return {"stdout": "", "error": f"{command[0]} timed out"}

        if result.returncode != 0:
            return {"stdout": result.stdout, "error": result.stderr.strip() or f"{command[0]} failed"}

        return {"stdout": result.stdout, "error": None}

    def current_timestamp(self) -> str:
        return datetime.now().isoformat(timespec="seconds")

    def bytes_per_second_to_mbps(self, value) -> float | None:
        if not isinstance(value, (int, float)):
            return None
        return (value * 8) / 1_000_000

    def bits_per_second_to_mbps(self, value) -> float | None:
        if not isinstance(value, (int, float)):
            return None
        return value / 1_000_000

    def fetch_market_quote(self, item: dict) -> dict:
        errors = []

        for market_url in MARKET_URLS:
            try:
                return self.fetch_yahoo_market_quote(item, market_url)
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
                errors.append(f"{market_url}: {exc}")

        raise ValueError("; ".join(errors) or "No market chart data returned")

    def fetch_yahoo_market_quote(self, item: dict, market_url: str) -> dict:
        symbol = item["symbol"]
        query = urlencode(
            {
                "interval": "5m",
                "range": "1d",
                "includePrePost": "false",
                "events": "div,splits",
            }
        )
        request = Request(
            f"{market_url}/{quote(symbol, safe='=^-')}" f"?{query}",
            headers={
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Connection": "close",
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36 SituationMonitor/1.0"
                ),
            },
        )

        with self.urlopen_with_ssl_retry(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))

        results = payload.get("chart", {}).get("result") or []
        if not results:
            error_payload = payload.get("chart", {}).get("error") or {}
            description = error_payload.get("description") or "No market chart data returned"
            raise ValueError(description)

        result = results[0]
        meta = result.get("meta", {})
        quotes = result.get("indicators", {}).get("quote", [{}])
        closes = quotes[0].get("close", []) if quotes else []
        series = [float(value) for value in closes if isinstance(value, (int, float))]

        current_price = meta.get("regularMarketPrice")
        if not isinstance(current_price, (int, float)) and series:
            current_price = series[-1]

        previous_close = meta.get("chartPreviousClose")
        if not isinstance(previous_close, (int, float)):
            previous_close = meta.get("previousClose")
        if not isinstance(previous_close, (int, float)) and series:
            previous_close = series[0]

        percent_change = None
        if isinstance(current_price, (int, float)) and isinstance(previous_close, (int, float)) and previous_close:
            percent_change = ((current_price - previous_close) / previous_close) * 100

        return {
            "symbol": symbol,
            "label": item["label"],
            "source_url": market_url,
            "currency": meta.get("currency") or "USD",
            "price": current_price,
            "previous_close": previous_close,
            "percent_change": percent_change,
            "points": series[-24:],
            "market_state": meta.get("marketState"),
        }

    def detect_active_interface(self) -> str | None:
        linux_interface = self.detect_linux_default_interface()
        if linux_interface:
            return linux_interface

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

    def detect_linux_default_interface(self) -> str | None:
        if not shutil.which("ip"):
            return None

        result = subprocess.run(
            ["ip", "route", "get", "1.1.1.1"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None

        parts = result.stdout.split()
        if "dev" not in parts:
            return None

        index = parts.index("dev")
        if index + 1 >= len(parts):
            return None

        interface = parts[index + 1]
        if interface.startswith(("lo", "docker", "br-", "veth")):
            return None

        return interface

    def read_ifconfig_details(self, interface: str) -> dict:
        linux_details = self.read_linux_interface_details(interface)
        if linux_details:
            return linux_details

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

    def read_linux_interface_details(self, interface: str) -> dict | None:
        if not shutil.which("ip"):
            return None

        result = subprocess.run(
            ["ip", "-4", "addr", "show", "dev", interface],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None

        ip_address = None
        status = "inactive"
        for line in result.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("inet "):
                ip_address = stripped.split()[1].split("/", 1)[0]
            if "state UP" in stripped:
                status = "active"

        return {"ip_address": ip_address, "status": status}

    def read_interface_counters(self, interface: str) -> dict | None:
        linux_counters = self.read_linux_interface_counters(interface)
        if linux_counters:
            return linux_counters

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

    def read_linux_interface_counters(self, interface: str) -> dict | None:
        stats_dir = Path("/sys/class/net") / interface / "statistics"
        rx_path = stats_dir / "rx_bytes"
        tx_path = stats_dir / "tx_bytes"
        if not rx_path.exists() or not tx_path.exists():
            return None

        try:
            return {
                "rx_bytes": int(rx_path.read_text().strip()),
                "tx_bytes": int(tx_path.read_text().strip()),
            }
        except (OSError, ValueError):
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

#!/usr/bin/env python3
# Big-Shot — Forensic web page capture helper.
#
# Reloads a URL in a headless Chromium (Playwright) and produces an
# evidence bundle suitable for legal/forensic use:
#   - full-page PNG, viewport PNG, MHTML, rendered HTML
#   - HAR (full network trace), request/response headers, redirect chain
#   - TLS certificate chain (PEM) + parsed metadata
#   - DNS resolution, server IP, environment info
#   - manifest.json with SHA-256 of every artifact
#   - optional RFC 3161 timestamp token (.tsr) over the manifest hash
#   - optional .zip bundle + sidecar .sha256
#
# CLI is stable and documented in docs/forensic-capture.md. The GNOME
# extension shells out to this script; the script is also useful standalone.

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import socket
import ssl
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse

FORMAT_VERSION = 1
DEFAULT_TSA_URL = "https://freetsa.org/tsr"
DEFAULT_VIEWPORT = (1366, 768)
DEFAULT_TIMEOUT_MS = 60_000


def log(msg: str, *, quiet: bool = False) -> None:
    if not quiet:
        print(f"[big-shot-forensic] {msg}", file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")


def safe_slug(value: str, maxlen: int = 60) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-.")
    return (slug or "page")[:maxlen]


def resolve_dns(host: str) -> dict:
    out: dict = {"host": host, "a": [], "aaaa": [], "error": None}
    try:
        infos = socket.getaddrinfo(host, None)
        for fam, *_rest, sockaddr in infos:
            ip = sockaddr[0]
            if fam == socket.AF_INET and ip not in out["a"]:
                out["a"].append(ip)
            elif fam == socket.AF_INET6 and ip not in out["aaaa"]:
                out["aaaa"].append(ip)
    except OSError as exc:
        out["error"] = str(exc)
    return out


def fetch_tls_chain(host: str, port: int = 443, timeout: float = 10.0) -> dict:
    # Returns parsed certificate metadata + PEM chain. Uses a fresh TCP
    # connection (independent of the browser) so the chain reflects what a
    # neutral observer would see at capture time.
    info: dict = {
        "host": host,
        "port": port,
        "error": None,
        "peer_ip": None,
        "leaf": None,
        "chain_pem": None,
        "chain_length": 0,
    }
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # capture even if invalid — record state, do not validate
        with socket.create_connection((host, port), timeout=timeout) as sock:
            info["peer_ip"] = sock.getpeername()[0]
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                der_chain = ssock.getpeercert(binary_form=True)
                # peercert (binary) returns only leaf; for full chain use _sslobj if available
                try:
                    chain = ssock.getpeercert_chain()  # type: ignore[attr-defined]
                except AttributeError:
                    chain = None
                pems: list[str] = []
                if chain:
                    for cert in chain:
                        pems.append(ssl.DER_cert_to_PEM_cert(cert.public_bytes(ssl.Purpose.SERVER_AUTH)))
                elif der_chain:
                    pems.append(ssl.DER_cert_to_PEM_cert(der_chain))
                info["chain_pem"] = "\n".join(pems) if pems else None
                info["chain_length"] = len(pems)
                # Parse leaf via cryptography if available, else minimal via ssl
                try:
                    from cryptography import x509
                    from cryptography.hazmat.primitives import hashes
                    from cryptography.hazmat.primitives.serialization import Encoding

                    if pems:
                        leaf = x509.load_pem_x509_certificate(pems[0].encode())
                        fp = leaf.fingerprint(hashes.SHA256()).hex()
                        info["leaf"] = {
                            "subject": leaf.subject.rfc4514_string(),
                            "issuer": leaf.issuer.rfc4514_string(),
                            "serial_number": format(leaf.serial_number, "x"),
                            "not_before_utc": leaf.not_valid_before_utc.isoformat()
                            if hasattr(leaf, "not_valid_before_utc")
                            else leaf.not_valid_before.isoformat(),
                            "not_after_utc": leaf.not_valid_after_utc.isoformat()
                            if hasattr(leaf, "not_valid_after_utc")
                            else leaf.not_valid_after.isoformat(),
                            "fingerprint_sha256": fp,
                            "signature_algorithm": leaf.signature_algorithm_oid._name,
                        }
                except ImportError:
                    # cryptography not installed — fall back to minimal info
                    if der_chain:
                        info["leaf"] = {
                            "fingerprint_sha256": hashlib.sha256(der_chain).hexdigest(),
                            "note": "install python-cryptography for full certificate parsing",
                        }
    except (OSError, ssl.SSLError) as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


def request_tsa_token(data_to_stamp: bytes, tsa_url: str, *, quiet: bool = False) -> bytes | None:
    # RFC 3161 Time-Stamp Protocol: build a TimeStampReq with SHA-256 of
    # data, POST to TSA, return raw TimeStampResp bytes (.tsr).
    # Uses `openssl ts` for portability — no Python ASN.1 dep needed.
    import shutil
    import tempfile

    openssl = shutil.which("openssl")
    curl = shutil.which("curl")
    if not openssl or not curl:
        log("openssl or curl missing — skipping TSA timestamp", quiet=quiet)
        return None

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        data_file = tdp / "data.bin"
        data_file.write_bytes(data_to_stamp)
        tsq = tdp / "request.tsq"
        tsr = tdp / "response.tsr"
        try:
            subprocess.run(
                [openssl, "ts", "-query", "-data", str(data_file), "-sha256", "-cert", "-no_nonce", "-out", str(tsq)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    curl,
                    "-sS",
                    "-H", "Content-Type: application/timestamp-query",
                    "--data-binary", f"@{tsq}",
                    "-o", str(tsr),
                    tsa_url,
                ],
                check=True,
                capture_output=True,
            )
            return tsr.read_bytes() if tsr.exists() and tsr.stat().st_size > 0 else None
        except subprocess.CalledProcessError as exc:
            log(f"TSA request failed: {exc.stderr.decode(errors='replace').strip()}", quiet=quiet)
            return None


def gather_environment(user_agent: str, viewport: tuple[int, int]) -> dict:
    try:
        import playwright  # type: ignore

        pw_version = playwright.__version__  # type: ignore[attr-defined]
    except Exception:
        pw_version = "unknown"
    return {
        "hostname": socket.gethostname(),
        "user": os.environ.get("USER") or os.environ.get("LOGNAME") or "unknown",
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "playwright_version": pw_version,
        "user_agent": user_agent,
        "viewport": {"width": viewport[0], "height": viewport[1]},
        "tz": dt.datetime.now(dt.timezone.utc).astimezone().tzname(),
        "tz_offset": dt.datetime.now(dt.timezone.utc).astimezone().utcoffset().total_seconds() if dt.datetime.now(dt.timezone.utc).astimezone().utcoffset() else 0,
    }


def capture(args: argparse.Namespace) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "ERROR: python-playwright not installed. Install with:\n"
            "  pip install --user playwright && playwright install chromium\n"
            "or via distribution package (e.g., python-playwright on Arch/BigLinux).",
            file=sys.stderr,
        )
        return 2

    quiet = args.quiet
    url = args.url
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        print(f"ERROR: invalid URL: {url!r}", file=sys.stderr)
        return 2

    viewport = tuple(int(v) for v in args.viewport.split("x", 1))  # type: ignore[assignment]
    if len(viewport) != 2:
        print(f"ERROR: --viewport must be WIDTHxHEIGHT (got {args.viewport!r})", file=sys.stderr)
        return 2

    user_agent = args.user_agent or (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 BigShotForensic"
    )

    capture_id = str(uuid.uuid4())
    requested_at = utc_now_iso()
    monotonic_start = time.monotonic()
    ts_slug = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    domain_slug = safe_slug(parsed.netloc)
    bundle_name = f"{ts_slug}_{domain_slug}"
    bundle_dir = Path(args.output_dir).expanduser().resolve() / bundle_name
    bundle_dir.mkdir(parents=True, exist_ok=False)

    log(f"capture {capture_id} → {bundle_dir}", quiet=quiet)

    redirects: list[dict] = []
    response_record: dict = {"status": None, "url": None, "headers": {}, "request_headers": {}}
    console_lines: list[str] = []

    har_path = bundle_dir / "network.har"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": viewport[0], "height": viewport[1]},
            user_agent=user_agent,
            record_har_path=str(har_path),
            record_har_content="embed",
            ignore_https_errors=False,  # record state honestly
        )
        page = context.new_page()
        page.on("console", lambda m: console_lines.append(f"[{m.type}] {m.text}"))

        def on_response(resp):
            if resp.request.is_navigation_request() and resp.request.redirected_from is None:
                # main document chain
                pass

        page.on("response", on_response)

        started_at = utc_now_iso()
        try:
            response = page.goto(url, wait_until="networkidle", timeout=args.timeout)
        except Exception as exc:
            log(f"navigation error: {exc}", quiet=quiet)
            response = None

        if response is not None:
            response_record["status"] = response.status
            response_record["url"] = response.url
            try:
                response_record["headers"] = dict(response.headers)
            except Exception:
                pass
            try:
                response_record["request_headers"] = dict(response.request.headers)
            except Exception:
                pass
            # walk redirect chain
            req = response.request
            chain_req = req.redirected_from
            while chain_req is not None:
                r = chain_req.response()
                redirects.insert(
                    0,
                    {
                        "url": chain_req.url,
                        "status": r.status if r else None,
                        "location": (r.headers.get("location") if r else None),
                    },
                )
                chain_req = chain_req.redirected_from

        # full page PNG
        page.screenshot(path=str(bundle_dir / "fullpage.png"), full_page=True, type="png")
        # viewport PNG
        page.screenshot(path=str(bundle_dir / "viewport.png"), full_page=False, type="png")
        # rendered HTML (post-JS DOM)
        (bundle_dir / "rendered.html").write_text(page.content(), encoding="utf-8")

        # MHTML via CDP
        try:
            client = context.new_cdp_session(page)
            mhtml = client.send("Page.captureSnapshot", {"format": "mhtml"})
            (bundle_dir / "page.mhtml").write_text(mhtml["data"], encoding="utf-8")
        except Exception as exc:
            log(f"MHTML capture unavailable: {exc}", quiet=quiet)

        finished_at = utc_now_iso()
        duration_s = time.monotonic() - monotonic_start

        context.close()
        browser.close()

    # console log
    (bundle_dir / "console.log").write_text("\n".join(console_lines), encoding="utf-8")

    # network (DNS + IP) — based on final URL host
    final_host = urlparse(response_record["url"] or url).hostname or parsed.hostname or ""
    dns_info = resolve_dns(final_host) if final_host else {}
    (bundle_dir / "dns.json").write_text(json.dumps(dns_info, indent=2), encoding="utf-8")

    # TLS chain
    tls_info = {}
    if final_host and (urlparse(response_record["url"] or url).scheme == "https"):
        port = urlparse(response_record["url"] or url).port or 443
        tls_info = fetch_tls_chain(final_host, port)
        if tls_info.get("chain_pem"):
            (bundle_dir / "certificate-chain.pem").write_text(tls_info["chain_pem"], encoding="utf-8")
        # do not store raw PEM twice in JSON
        tls_info_for_json = {k: v for k, v in tls_info.items() if k != "chain_pem"}
        (bundle_dir / "certificate-info.json").write_text(
            json.dumps(tls_info_for_json, indent=2), encoding="utf-8"
        )

    # headers + redirect chain
    (bundle_dir / "headers.json").write_text(
        json.dumps(
            {
                "final": response_record,
                "redirect_chain": redirects,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # environment
    env = gather_environment(user_agent, viewport)
    (bundle_dir / "env.json").write_text(json.dumps(env, indent=2), encoding="utf-8")

    # ---- build manifest with hashes of all artifacts ----
    artifacts: dict[str, dict] = {}
    for child in sorted(bundle_dir.iterdir()):
        if child.is_file() and child.name != "manifest.json":
            artifacts[child.name] = {
                "sha256": sha256_file(child),
                "size": child.stat().st_size,
            }

    manifest = {
        "format_version": FORMAT_VERSION,
        "tool": {
            "name": "big-shot-forensic-capture",
            "version": args.tool_version,
        },
        "capture_id": capture_id,
        "url_requested": url,
        "url_final": response_record["url"],
        "redirect_chain": redirects,
        "http_status": response_record["status"],
        "timestamps": {
            "requested_at_utc": requested_at,
            "started_at_utc": started_at,
            "finished_at_utc": finished_at,
            "duration_seconds": round(duration_s, 3),
        },
        "network": {
            "dns": dns_info,
            "peer_ip": tls_info.get("peer_ip") if tls_info else None,
        },
        "tls": {k: v for k, v in tls_info.items() if k != "chain_pem"} if tls_info else None,
        "environment": env,
        "artifacts": artifacts,
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    (bundle_dir / "manifest.sha256").write_text(f"{manifest_hash}  manifest.json\n", encoding="utf-8")

    # ---- optional RFC 3161 timestamp ----
    if args.tsa:
        log(f"requesting RFC 3161 timestamp from {args.tsa_url}", quiet=quiet)
        tsr = request_tsa_token(manifest_bytes, args.tsa_url, quiet=quiet)
        if tsr:
            (bundle_dir / "timestamp.tsr").write_bytes(tsr)
            (bundle_dir / "timestamp.info").write_text(
                json.dumps(
                    {
                        "tsa_url": args.tsa_url,
                        "stamped_file": "manifest.json",
                        "stamped_sha256": manifest_hash,
                        "tsr_sha256": hashlib.sha256(tsr).hexdigest(),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )

    # ---- optional ZIP ----
    if not args.no_zip:
        zip_path = bundle_dir.with_suffix(".zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for child in sorted(bundle_dir.rglob("*")):
                if child.is_file():
                    zf.write(child, arcname=str(child.relative_to(bundle_dir.parent)))
        zip_hash = sha256_file(zip_path)
        zip_path.with_suffix(".zip.sha256").write_text(
            f"{zip_hash}  {zip_path.name}\n", encoding="utf-8"
        )
        log(f"bundle: {zip_path}  sha256={zip_hash}", quiet=quiet)
    else:
        log(f"bundle dir: {bundle_dir}", quiet=quiet)

    # machine-readable result on stdout (for the GNOME extension to parse)
    print(json.dumps({
        "capture_id": capture_id,
        "bundle_dir": str(bundle_dir),
        "zip_path": str(bundle_dir.with_suffix(".zip")) if not args.no_zip else None,
        "manifest_sha256": manifest_hash,
        "url_final": response_record["url"],
        "http_status": response_record["status"],
    }, indent=2))

    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="big-shot-forensic-capture",
        description="Capture a webpage as a forensic evidence bundle (Big-Shot helper).",
    )
    p.add_argument("--url", required=True, help="URL to capture (must include scheme).")
    p.add_argument(
        "--output-dir",
        default=str(Path.home() / "Imagens" / "BigShot-Forense"),
        help="Parent directory for the bundle (default: ~/Imagens/BigShot-Forense).",
    )
    p.add_argument(
        "--viewport",
        default=f"{DEFAULT_VIEWPORT[0]}x{DEFAULT_VIEWPORT[1]}",
        help="Viewport size WIDTHxHEIGHT (default: 1366x768).",
    )
    p.add_argument("--user-agent", default=None, help="Custom User-Agent string.")
    p.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_MS,
        help="Navigation timeout in ms (default: 60000).",
    )
    p.add_argument("--tsa", action="store_true", help="Request RFC 3161 timestamp.")
    p.add_argument("--tsa-url", default=DEFAULT_TSA_URL, help=f"TSA endpoint (default: {DEFAULT_TSA_URL}).")
    p.add_argument("--no-zip", action="store_true", help="Skip building the .zip bundle.")
    p.add_argument("--quiet", action="store_true", help="Suppress progress logs on stderr.")
    p.add_argument(
        "--tool-version",
        default="0.1.0",
        help="Tool version string recorded in manifest (set by packaging).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return capture(args)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())

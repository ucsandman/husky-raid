#!/usr/bin/env python3
"""One-command launcher for RIFTLANE.

    python launch.py            # install deps if needed, build if stale, serve, open browser
    python launch.py --port 9000
    python launch.py --no-browser
    python launch.py --rebuild  # force a fresh client build

Requires Python 3.8+ and Node.js >= 20 on PATH. Ctrl+C stops the server.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(cmd: list, **kwargs) -> None:
    print(f"[launch] {' '.join(cmd[1:]) or cmd[0]}")
    subprocess.run(cmd, cwd=ROOT, check=True, **kwargs)


def newest_mtime(*paths: Path) -> float:
    newest = 0.0
    for p in paths:
        if p.is_file():
            newest = max(newest, p.stat().st_mtime)
        elif p.is_dir():
            for f in p.rglob("*"):
                if f.is_file():
                    newest = max(newest, f.stat().st_mtime)
    return newest


def main() -> int:
    parser = argparse.ArgumentParser(description="Run RIFTLANE locally in one command.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open a browser tab"
    )
    parser.add_argument(
        "--rebuild", action="store_true", help="force a fresh client build"
    )
    args = parser.parse_args()

    npm = shutil.which("npm")
    node = shutil.which("node")
    if not npm or not node:
        print(
            "error: Node.js >= 20 (with npm) must be on PATH. https://nodejs.org",
            file=sys.stderr,
        )
        return 1
    node_major = int(
        subprocess.check_output([node, "--version"], text=True)
        .strip()
        .lstrip("v")
        .split(".")[0]
    )
    if node_major < 20:
        print(f"error: Node.js >= 20 required, found v{node_major}.", file=sys.stderr)
        return 1

    if not (ROOT / "node_modules").is_dir():
        run([npm, "install"])

    # Rebuild when the built client is missing or older than any client/shared source.
    dist_index = ROOT / "client" / "dist" / "index.html"
    sources = newest_mtime(
        ROOT / "client" / "src", ROOT / "client" / "index.html", ROOT / "shared" / "src"
    )
    if args.rebuild or not dist_index.is_file() or dist_index.stat().st_mtime < sources:
        run([npm, "run", "build"])

    env = {**os.environ, "PORT": str(args.port)}
    server = subprocess.Popen([npm, "run", "start"], cwd=ROOT, env=env)
    url = f"http://localhost:{args.port}"
    try:
        for _ in range(60):
            if server.poll() is not None:
                print("error: server exited during startup.", file=sys.stderr)
                return server.returncode or 1
            try:
                urllib.request.urlopen(url, timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        else:
            print("error: server did not come up within 30s.", file=sys.stderr)
            return 1

        print(f"[launch] RIFTLANE running at {url} (Ctrl+C to stop)")
        if not args.no_browser:
            webbrowser.open(url)
        server.wait()
        return server.returncode or 0
    except KeyboardInterrupt:
        print("\n[launch] stopping server...")
        return 0
    finally:
        if server.poll() is None:
            if os.name == "nt":
                # npm wraps node in a cmd shim on Windows; kill the whole tree by PID.
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(server.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()


if __name__ == "__main__":
    sys.exit(main())

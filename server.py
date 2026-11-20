#!/usr/bin/env python3
"""Reel Maker helper: run Reel Maker on a phone or tablet with YouTube links.

Run this on an Android tablet (in Termux) or any computer, then open http://localhost:8765 in its
browser. The app is passed through from the Reel Maker website, so it opens at the same address as
the helper, and the Video step gets a "Paste a YouTube link" box: the helper downloads the video
with yt-dlp and hands it to the app.

Only use it with videos you have permission to use.

Setup on Android (Termux, from F-Droid):
    pkg update && pkg upgrade
    pkg install python ffmpeg
    pip install -U yt-dlp
    curl -O https://reel-editor-omega.vercel.app/server.py
    python server.py

Options: --port, --quality (720 or 1080), --max-minutes, --lan (let other devices on your Wi-Fi
use it), --app (where to get the app from), --allow-any-site (links from sites other than YouTube).
"""

import argparse
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import yt_dlp
except ImportError:  # the app still opens; the link box explains what's missing
    yt_dlp = None

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com",
}
KEEP_FILES_FOR = 2 * 3600  # downloaded videos are deleted after two hours
APP_CACHE_FOR = 600  # app files are re-fetched from the website after ten minutes

ARGS = None
JOBS = {}
JOBS_LOCK = threading.Lock()
APP_CACHE = {}


def strip_ansi(text):
    return re.sub(r"\x1b\[[0-9;]*m", "", str(text))


def allowed_url(url):
    try:
        parts = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    return ARGS.allow_any_site or parts.hostname.lower() in YOUTUBE_HOSTS


def download(job_id, url):
    """Runs in a thread: downloads one video and records progress in JOBS[job_id]."""
    job = JOBS[job_id]
    folder = os.path.join(ARGS.downloads, job_id)
    os.makedirs(folder, exist_ok=True)

    def on_progress(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            # Video and audio come as two downloads, then get joined: show them as one bar.
            part = 0 if job["parts_done"] == 0 else 1
            share = done / total if total else 0
            job["percent"] = round(min(99, (part + share) * 50 if job["two_parts"] else share * 99), 1)
            job["status"] = "downloading"
        elif d.get("status") == "finished":
            job["parts_done"] += 1

    def too_long(info, *, incomplete=False):
        duration = info.get("duration")
        if duration and duration > ARGS.max_minutes * 60:
            return f"The video is {round(duration / 60)} minutes long; the limit is {ARGS.max_minutes}."
        return None

    height = ARGS.quality
    options = {
        # MP4 video and M4A audio up to the chosen height, joined into one MP4 (needs ffmpeg).
        "format": (
            f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
            f"b[height<={height}][ext=mp4]/bv*[height<={height}]+ba/b[height<={height}]/b"
        ),
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(folder, "video.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,  # progress goes to the app; keep the terminal tidy
        "no_warnings": True,
        "progress_hooks": [on_progress],
        "match_filter": too_long,
        "postprocessor_hooks": [lambda d: job.update(status="joining") if d.get("status") == "started" else None],
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
            message = too_long(info)
            if message:
                raise ValueError(message)
            job["title"] = info.get("title") or "video"
            job["two_parts"] = bool(info.get("requested_formats"))
            ydl.process_ie_result(info, download=True)
        files = [f for f in os.listdir(folder) if not f.endswith((".part", ".ytdl"))]
        if not files:
            raise ValueError("the download didn't produce a file")
        path = os.path.join(folder, sorted(files, key=lambda f: os.path.getsize(os.path.join(folder, f)))[-1])
        job.update(status="done", percent=100, file=path, size=os.path.getsize(path))
        print(f"[done] {job['title']} ({job['size'] / 1048576:.1f} MB)")
    except Exception as err:  # noqa: BLE001 - every failure is reported to the app
        message = strip_ansi(err).replace("ERROR: ", "")
        job.update(status="error", error=message)
        print(f"[error] {url}: {message}")


def clean_up():
    """Deletes downloads older than KEEP_FILES_FOR."""
    while True:
        now = time.time()
        with JOBS_LOCK:
            for job_id, job in list(JOBS.items()):
                if now - job["created"] > KEEP_FILES_FOR:
                    shutil.rmtree(os.path.join(ARGS.downloads, job_id), ignore_errors=True)
                    del JOBS[job_id]
        time.sleep(300)


class Handler(BaseHTTPRequestHandler):
    server_version = "ReelMakerHelper/1.0"

    def log_message(self, fmt, *args):  # quieter: only API calls are printed
        if self.path.startswith("/api/"):
            print(f"[{self.command}] {self.path}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/health":
            return self.send_json({
                "ok": True,
                "ytdlp": yt_dlp.version.__version__ if yt_dlp else None,
                "ffmpeg": bool(shutil.which("ffmpeg")),
                "quality": ARGS.quality,
                "maxMinutes": ARGS.max_minutes,
            })
        match = re.fullmatch(r"/api/job/([0-9a-f]{32})", path)
        if match:
            job = JOBS.get(match.group(1))
            if not job:
                return self.send_json({"error": "unknown download"}, 404)
            return self.send_json({k: job[k] for k in ("status", "percent", "title", "error", "size")})
        match = re.fullmatch(r"/api/file/([0-9a-f]{32})", path)
        if match:
            job = JOBS.get(match.group(1))
            if not job or job["status"] != "done":
                return self.send_json({"error": "not ready"}, 404)
            return self.send_file(job["file"])
        return self.proxy_app(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/fetch":
            return self.send_json({"error": "not found"}, 404)
        if not yt_dlp:
            return self.send_json({"error": "yt-dlp isn't installed: run  pip install -U yt-dlp  and restart the helper"}, 500)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            url = json.loads(self.rfile.read(min(length, 10000)) or b"{}").get("url", "").strip()
        except (ValueError, json.JSONDecodeError):
            return self.send_json({"error": "bad request"}, 400)
        if not allowed_url(url):
            return self.send_json({"error": "That doesn't look like a YouTube link."}, 400)
        with JOBS_LOCK:
            if any(j["status"] in ("starting", "downloading", "joining") for j in JOBS.values()):
                return self.send_json({"error": "Another download is still running. Try again when it's done."}, 409)
            job_id = uuid.uuid4().hex
            JOBS[job_id] = {
                "status": "starting", "percent": 0, "title": "", "error": "", "size": 0,
                "file": None, "created": time.time(), "parts_done": 0, "two_parts": True,
            }
        threading.Thread(target=download, args=(job_id, url), daemon=True).start()
        print(f"[start] {url}")
        return self.send_json({"id": job_id})

    def send_file(self, path):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    def proxy_app(self, path):
        """Serves Reel Maker's own files, fetched from the website (and cached for a while)."""
        if ".." in path:
            return self.send_json({"error": "not found"}, 404)
        cached = APP_CACHE.get(path)
        if not cached or time.time() - cached[0] > APP_CACHE_FOR:
            try:
                with urllib.request.urlopen(ARGS.app.rstrip("/") + path, timeout=30) as resp:
                    cached = (time.time(), resp.status, resp.headers.get("Content-Type", "application/octet-stream"), resp.read())
            except urllib.error.HTTPError as err:
                cached = (time.time(), err.code, "text/plain", f"{err.code} {err.reason}".encode())
            except (urllib.error.URLError, OSError) as err:
                return self.send_json({"error": f"couldn't load the app from {ARGS.app}: {err}"}, 502)
            APP_CACHE[path] = cached
        _, status, ctype, body = cached
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    global ARGS
    parser = argparse.ArgumentParser(description="Reel Maker helper: YouTube links for Reel Maker.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--quality", type=int, choices=(480, 720, 1080), default=720,
                        help="highest video height to download (default 720: easier on a phone's memory)")
    parser.add_argument("--max-minutes", type=int, default=60, help="longest video to download (default 60)")
    parser.add_argument("--lan", action="store_true", help="let other devices on your Wi-Fi use the helper")
    parser.add_argument("--app", default="https://reel-editor-omega.vercel.app", help="where to load the app from")
    parser.add_argument("--downloads", default=os.path.expanduser("~/reelmaker-downloads"))
    parser.add_argument("--allow-any-site", action="store_true", help="accept links from sites other than YouTube")
    ARGS = parser.parse_args()
    os.makedirs(ARGS.downloads, exist_ok=True)
    threading.Thread(target=clean_up, daemon=True).start()

    host = "0.0.0.0" if ARGS.lan else "127.0.0.1"
    server = ThreadingHTTPServer((host, ARGS.port), Handler)
    print("Reel Maker helper is running.")
    print(f"  Open  http://localhost:{ARGS.port}  in Chrome on this device.")
    if ARGS.lan and lan_address():
        print(f"  Other devices on your Wi-Fi: http://{lan_address()}:{ARGS.port}")
    if not yt_dlp:
        print("  yt-dlp is missing: run  pip install -U yt-dlp  then restart.")
    if not shutil.which("ffmpeg"):
        print("  ffmpeg is missing: run  pkg install ffmpeg  (videos may download without sound).")
    print("  Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# =============================================================================
#  Pulls course watch-progress from the LMS "Code Monkey - Course Status" API
#  and writes a snapshot for the /progress/ dashboard.
#
#  The API key stays on the server (never shipped to the browser). The output
#  keeps only each learner's name, last-activity time and average watch
#  percentage.
#
#  Run by the codemonkey-progress.timer systemd unit (see install-progress-sync.sh).
#
#  Environment:
#    CM_API_KEY   (required) LMS API key
#    CM_API_URL   (optional) defaults to the production endpoint
#    CM_OUT_FILE  (optional) defaults to /var/lib/codemonkey/progress.json
# =============================================================================
import json
import os
import sys
import tempfile
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

API_URL = os.environ.get("CM_API_URL", "https://lms.dcc.bde.go.th/apis/codemonkey_api/course_status")
OUT_FILE = os.environ.get("CM_OUT_FILE", "/var/lib/codemonkey/progress.json")
BANGKOK = timezone(timedelta(hours=7))


def fetch(api_key):
    req = urllib.request.Request(
        API_URL,
        data=b"",  # no filters: all statuses, all dates
        method="POST",
        headers={"API-KEY": api_key, "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def snapshot(payload):
    if not payload.get("status") or not isinstance(payload.get("data"), list):
        raise ValueError("API returned status=false or no data array: %r" % payload.get("message"))
    rows = payload["data"]
    learners = []
    for r in rows:
        name = " ".join(str(r.get(k) or "").strip() for k in ("firstname", "lastname")).strip()
        # cdate = latest watch-history update, to the minute.
        learners.append([str(r["cdate"])[:16], int(r["watch_percentage"]), name])
    learners.sort()
    lessons = Counter(int(r["topic"]) for r in rows).most_common(1)
    return {
        "generated_at": datetime.now(BANGKOK).strftime("%Y-%m-%d %H:%M"),
        "total": len(learners),
        "lessons": lessons[0][0] if lessons else None,
        "learners": learners,  # [last_activity "YYYY-MM-DD HH:MM", avg_watch_percent, name]
    }


def write_atomic(path, obj):
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".progress-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    api_key = os.environ.get("CM_API_KEY", "").strip()
    if not api_key:
        sys.exit("CM_API_KEY is not set")
    snap = snapshot(fetch(api_key))
    write_atomic(OUT_FILE, snap)
    print("wrote %d learners to %s" % (snap["total"], OUT_FILE))


if __name__ == "__main__":
    main()

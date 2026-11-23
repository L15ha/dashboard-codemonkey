#!/usr/bin/env python3
# =============================================================================
#  Pulls learner progress straight from CodeMonkey's Thailand API and writes
#  the snapshot for the /progress/ dashboard (same file the LMS sync writes,
#  so only one of the two timers should be enabled).
#
#  Flow:
#    1. GET the program's learner list (uid, display name, last sign-in).
#    2. GET /api/v1/users/{uid}/courses.json only for learners who are new,
#       signed in since the last fetch, or not refreshed for FULL_REFRESH_DAYS
#       (per CodeMonkey's advice: most learners don't change between syncs).
#    3. Join school/province from an optional roster CSV, drop hidden names,
#       write the snapshot atomically.
#
#  Run by the codemonkey-cm.timer systemd unit (see install-codemonkey-sync.sh).
#
#  Environment:
#    CM_CODEMONKEY_KEY  (required) Bearer key from CodeMonkey
#    CM_CM_BASE         (optional) https://app.codemonkey.com
#    CM_CM_USERS_PATH   (optional) learner-list endpoint (default below), 100 per page
#    CM_CM_CREATED_FROM (optional) "YYYY-MM-DD": only learners whose CodeMonkey
#                       account was created on/after this date (one cohort);
#                       empty = everyone who ever signed in via the integration
#    CM_CM_COURSES      (optional) course keys shown on the page, comma-separated;
#                       the first one is the main % (almost all learners are in part 1)
#    CM_OUT_FILE        (optional) /var/lib/codemonkey/progress.json
#    CM_STATE_FILE      (optional) /var/lib/codemonkey/cm-state.json (not served)
#    CM_HIDDEN_FILE     (optional) /etc/codemonkey/hidden-names.txt
#    CM_ROSTER_FILE     (optional) /etc/codemonkey/roster.csv - UTF-8 CSV with a
#                       header row: school + province, and uid and/or name
#                       (or firstname + lastname). uid matches are exact; name
#                       matches ignore Thai/English titles and spacing.
#    CM_FULL=1          (optional) refetch every learner this run
# =============================================================================
import csv
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("CM_CM_BASE", "https://app.codemonkey.com").rstrip("/")
USERS_PATH = os.environ.get("CM_CM_USERS_PATH", "/api/v1/users.json")
CREATED_FROM = os.environ.get("CM_CM_CREATED_FROM", "").strip()
COURSES = [c.strip() for c in os.environ.get(
    "CM_CM_COURSES", "coding_adventure_part_1,coding_adventure_part_2,coding_adventure_part_3").split(",") if c.strip()]
COURSE_LABELS = {
    "coding_adventure_part_1": "ตอนที่ 1",
    "coding_adventure_part_2": "ตอนที่ 2",
    "coding_adventure_part_3": "ตอนที่ 3",
}
OUT_FILE = os.environ.get("CM_OUT_FILE", "/var/lib/codemonkey/progress.json")
STATE_FILE = os.environ.get("CM_STATE_FILE", "/var/lib/codemonkey/cm-state.json")
HIDDEN_FILE = os.environ.get("CM_HIDDEN_FILE", "/etc/codemonkey/hidden-names.txt")
ROSTER_FILE = os.environ.get("CM_ROSTER_FILE", "/etc/codemonkey/roster.csv")
FULL_REFRESH_DAYS = 7
WORKERS = 4
MAX_FAILED_SHARE = 0.2  # keep the previous snapshot if more progress calls fail than this...
MIN_FAILED = 5          # ...and at least this many (one broken learner must not block every update)
BANGKOK = timezone(timedelta(hours=7))
TITLES = re.compile(r"^(นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|mr\.?|mrs\.?|ms\.?|miss)\s*", re.I)


def norm_name(s):
    return " ".join(str(s or "").split())


def match_key(s):
    return TITLES.sub("", norm_name(s)).replace(" ", "").lower()


# ---------- HTTP ----------
def get_json(url, key, tries=4):
    req = urllib.request.Request(url, headers={"accept": "application/json", "Authorization": "Bearer " + key})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                wait = e.headers.get("Retry-After")
                time.sleep(float(wait) if wait and wait.isdigit() else 2 ** attempt)
                continue
            raise
        except urllib.error.URLError:
            if attempt < tries - 1:
                time.sleep(2 ** attempt)
                continue
            raise


def results_of(payload):
    if isinstance(payload, list):
        return payload
    for k in ("results", "users", "data"):
        if isinstance(payload.get(k), list):
            return payload[k]
    raise ValueError("unexpected response shape: keys %s" % sorted(payload)[:10])


def next_url(payload, url):
    # Documented paging is page/total_pages; a "next" link is followed too in case it changes.
    if not isinstance(payload, dict):
        return None
    nxt = payload.get("next") or payload.get("next_page_url")
    if isinstance(nxt, str) and nxt:
        return urllib.parse.urljoin(url, nxt)
    page, pages = payload.get("page"), payload.get("total_pages")
    if isinstance(page, int) and isinstance(pages, int) and page < pages:
        parts = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(parts.query))
        q["page"] = str(page + 1)
        return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(q)))
    return None


def parse_time(v):
    """Epoch seconds/ms or ISO-8601 -> 'YYYY-MM-DD HH:MM' Bangkok time, '' if unknown."""
    if v in (None, ""):
        return ""
    try:
        if isinstance(v, (int, float)) or re.fullmatch(r"\d{9,13}", str(v)):
            t = float(v)
            dt = datetime.fromtimestamp(t / 1000 if t > 1e11 else t, timezone.utc)
        else:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(BANGKOK).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return ""


def fetch_users(key):
    users, url = [], BASE + USERS_PATH
    while url:
        payload = get_json(url, key)
        for u in results_of(payload):
            uid = u.get("uid", u.get("id"))
            if uid in (None, ""):
                continue
            last = next((u[k] for k in ("latest_sign_in_at", "last_sign_in_at", "last_sign_in", "last_login_at") if k in u), None)
            users.append({"uid": str(uid), "name": norm_name(u.get("display_name") or u.get("name")),
                          "last": parse_time(last), "created": parse_time(u.get("created_at"))})
        url = next_url(payload, url)
    return users


def fetch_progress(key, uid):
    payload = get_json("%s/api/v1/users/%s/courses.json" % (BASE, urllib.parse.quote(uid, safe="")), key)
    return {str(c.get("key")): round(float(c.get("progress") or 0) * 100) for c in results_of(payload)}


# ---------- local files ----------
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def load_hidden(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            lines = [norm_name(l) for l in f]
    except FileNotFoundError:
        return set()
    return {l for l in lines if l and not l.startswith("#")}


def load_roster(path):
    """-> (by_uid, by_name) maps of (school, province)."""
    by_uid, by_name = {}, {}
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
                info = (row.get("school", ""), row.get("province", ""))
                if row.get("uid"):
                    by_uid[row["uid"]] = info
                name = row.get("name") or " ".join(x for x in (row.get("firstname"), row.get("lastname")) if x)
                if name:
                    by_name.setdefault(match_key(name), info)
    except FileNotFoundError:
        pass
    return by_uid, by_name


def write_atomic(path, obj):
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".cm-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


# ---------- main ----------
def needs_fetch(user, prev, now, full):
    if full or not prev or "progress" not in prev:
        return True
    if user["last"] and user["last"] != prev.get("last"):
        return True
    fetched = prev.get("fetched", "")
    return not fetched or fetched < (now - timedelta(days=FULL_REFRESH_DAYS)).strftime("%Y-%m-%d %H:%M")


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Thai names in log lines
    key = os.environ.get("CM_CODEMONKEY_KEY", "").strip()
    if not key:
        sys.exit("CM_CODEMONKEY_KEY is not set")
    now = datetime.now(BANGKOK)
    stamp = now.strftime("%Y-%m-%d %H:%M")

    users = fetch_users(key)
    if CREATED_FROM:
        users = [u for u in users if u["created"] >= CREATED_FROM]
    state = load_json(STATE_FILE, {})
    todo = [u for u in users if needs_fetch(u, state.get(u["uid"]), now, os.environ.get("CM_FULL") == "1")]

    failed = []
    def work(u):
        try:
            return u, fetch_progress(key, u["uid"])
        except Exception as e:  # keep the learner's previous progress
            failed.append((u["uid"], str(e)))
            return u, None
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for u, prog in pool.map(work, todo):
            if prog is not None:
                state[u["uid"]] = {"last": u["last"], "fetched": stamp, "progress": prog}
    if len(failed) >= MIN_FAILED and len(failed) > MAX_FAILED_SHARE * len(todo):
        write_atomic(STATE_FILE, state)
        sys.exit("%d of %d progress calls failed (e.g. %s) - kept previous snapshot" % (len(failed), len(todo), failed[0][1]))

    hidden, hidden_hits = load_hidden(HIDDEN_FILE), set()
    by_uid, by_name = load_roster(ROSTER_FILE)
    learners, matched = [], 0
    for u in users:
        if u["name"] in hidden:
            hidden_hits.add(u["name"])
            continue
        prog = (state.get(u["uid"]) or {}).get("progress", {})
        parts = [min(int(prog.get(c, 0)), 100) for c in COURSES]
        school, province = by_uid.get(u["uid"]) or by_name.get(match_key(u["name"])) or ("", "")
        matched += bool(school or province)
        main = parts[0] if parts else 0
        learners.append([u["last"], main, u["name"], school, province] + parts)
    learners.sort(key=lambda l: l[2])
    for name in sorted(hidden - hidden_hits):
        print("warning: hidden name not found in CodeMonkey data: %s" % name)

    write_atomic(STATE_FILE, state)
    write_atomic(OUT_FILE, {
        "source": "codemonkey",
        "generated_at": stamp,
        "total": len(learners),
        "hidden": len(hidden_hits),
        "roster_matched": matched,
        "created_from": CREATED_FROM,
        "courses": [{"key": c, "label": COURSE_LABELS.get(c, c)} for c in COURSES],
        # [last_sign_in "YYYY-MM-DD HH:MM", main % (first course), name, school, province, <% per course in "courses">]
        "learners": learners,
    })
    print("wrote %d learners (%d hidden, %d with school, %d fetched, %d failed) to %s"
          % (len(learners), len(hidden_hits), matched, len(todo) - len(failed), len(failed), OUT_FILE))


if __name__ == "__main__":
    main()

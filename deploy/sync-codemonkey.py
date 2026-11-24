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
#    3. Join schools from the project's Google Sheet (re-read every run, so new
#       mappings appear on the next sync) or an optional roster CSV, drop hidden
#       names, write the snapshot atomically.
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
#    CM_SCHOOL_SHEET_ID / CM_SCHOOL_SHEET_GID  (optional) Google Sheet + tab that maps
#                       CodeMonkey display names to schools; it must be viewable by link.
#                       Only the two columns below are downloaded (never e-mails etc.).
#    CM_SCHOOL_NAME_COL / CM_SCHOOL_COL  (optional) sheet columns, default D and J
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
# key -> (full name for headers/notes, short name for status badges and summary cards)
COURSE_LABELS = {
    "coding_adventure_part_1": ("Coding Adventure Part I: Fundamentals", "Part I"),
    "coding_adventure_part_2": ("Coding Adventure Part II: Functions & Conditions", "Part II"),
    "coding_adventure_part_3": ("Coding Adventure Part III: Logic & Events", "Part III"),
}
OUT_FILE = os.environ.get("CM_OUT_FILE", "/var/lib/codemonkey/progress.json")
STATE_FILE = os.environ.get("CM_STATE_FILE", "/var/lib/codemonkey/cm-state.json")
HIDDEN_FILE = os.environ.get("CM_HIDDEN_FILE", "/etc/codemonkey/hidden-names.txt")
ROSTER_FILE = os.environ.get("CM_ROSTER_FILE", "/etc/codemonkey/roster.csv")
SHEET_ID = os.environ.get("CM_SCHOOL_SHEET_ID", "").strip()
SHEET_GID = os.environ.get("CM_SCHOOL_SHEET_GID", "0").strip()
SHEET_NAME_COL = os.environ.get("CM_SCHOOL_NAME_COL", "D").strip()
SHEET_SCHOOL_COL = os.environ.get("CM_SCHOOL_COL", "J").strip()
SHEET_CACHE = os.path.join(os.path.dirname(STATE_FILE), "school-map.json")
# Labels the project team uses in the sheet's school column besides real school names.
PRE_PROGRAM = "ผู้ใช้สิทธิ์ในปี 2023-2025 ก่อนเริ่มโครงการ"   # accounts created before the program (2026)
NOT_FOUND = "ไม่พบชื่อโรงเรียน/บุคคลนอกโครงการ"
TEAM = "ทีมงานโครงการ"
PENDING = "ยังไม่ได้จับคู่โรงเรียน"                     # ours: signed up after the sheet was last updated
PROGRAM_START = "2026-01-01"
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


def sheet_column(col, last_row):
    url = "https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s&range=%s1:%s%d" % (
        urllib.parse.quote(SHEET_ID), urllib.parse.quote(SHEET_GID), col, col, last_row)
    with urllib.request.urlopen(url, timeout=60) as resp:
        if "text/csv" not in resp.headers.get("Content-Type", ""):
            raise ValueError("sheet is not viewable by link (got %s)" % resp.headers.get("Content-Type"))
        return [(r[0] if r else "") for r in csv.reader(resp.read().decode("utf-8").splitlines())]


def load_sheet_map():
    """-> {display name: [school labels]} from the project sheet; falls back to the last good copy."""
    if not SHEET_ID:
        return {}
    try:
        names = sheet_column(SHEET_NAME_COL, 100000)  # trailing empty rows are trimmed by Google
        schools = sheet_column(SHEET_SCHOOL_COL, len(names))  # the school column has ~50k formula rows: stop at the last name
        mapping = {}
        for name, school in list(zip(names, schools))[1:]:  # row 1 = headers
            name, school = norm_name(name), norm_name(school)
            if name and school and school not in mapping.setdefault(name, []):
                mapping[name].append(school)
        write_atomic(SHEET_CACHE, mapping)
        return mapping
    except Exception as e:
        print("warning: school sheet not read (%s) - using last good copy" % e)
        return load_json(SHEET_CACHE, {})


def school_for(user, labels):
    """Pick one label; a name can map to several when people share it - the creation date tells them apart."""
    early = bool(user["created"]) and user["created"] < PROGRAM_START
    if labels:
        same_era = [l for l in labels if (l == PRE_PROGRAM) == early]
        return (same_era or labels)[0]
    return PRE_PROGRAM if early else PENDING


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
    sheet = load_sheet_map()
    learners, matched = [], 0
    for u in users:
        if u["name"] in hidden:
            hidden_hits.add(u["name"])
            continue
        prog = (state.get(u["uid"]) or {}).get("progress", {})
        parts = [min(int(prog.get(c, 0)), 100) for c in COURSES]
        if u["uid"] in by_uid:
            school, province = by_uid[u["uid"]]
        elif sheet:
            school, province = school_for(u, sheet.get(u["name"])), ""
        else:
            school, province = by_name.get(match_key(u["name"])) or ("", "")
        matched += bool(school or province) and school != PENDING
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
        # school labels that are categories, not schools (the page lists them apart)
        "school_categories": [TEAM, PRE_PROGRAM, NOT_FOUND, PENDING] if sheet else [],
        "courses": [{"key": c, "label": COURSE_LABELS.get(c, (c, c))[0], "short": COURSE_LABELS.get(c, (c, c))[1]} for c in COURSES],
        # [last_sign_in "YYYY-MM-DD HH:MM", main % (first course), name, school, province, <% per course in "courses">]
        "learners": learners,
    })
    print("wrote %d learners (%d hidden, %d with school, %d fetched, %d failed) to %s"
          % (len(learners), len(hidden_hits), matched, len(todo) - len(failed), len(failed), OUT_FILE))


if __name__ == "__main__":
    main()

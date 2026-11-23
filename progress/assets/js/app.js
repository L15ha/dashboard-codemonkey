/* Code Monkey — course progress dashboard. Snapshot from data/progress.json, written on the server by either
     deploy/sync-progress.py   (source "lms"):        learners = [[activated, avg_watch_%, name], ...]
     deploy/sync-codemonkey.py (source "codemonkey"): learners = [[last_sign_in, main_% (= course 1), name, school, province, %course1, %course2, ...], ...]
   Dates are "YYYY-MM-DD HH:MM". The LMS date is the activation time (it does not update). */
(function () {
  "use strict";

  var DATA_URL = "data/progress.json";      // served by nginx from /var/lib/codemonkey (see deploy/)
  var FALLBACK_URL = "data/sample.json";    // synthetic data for local preview
  var W = 0, P = 1, N = 2, S = 3, V = 4, PARTS = 5;  // row columns

  var snap = null, cm = false, hasRoster = false;
  var charts = {};
  var state = { from: "", q: "", status: "", prov: "", school: "", sort: "pct-desc", shown: [] };

  /* Per-source wording (a value may be a function, evaluated once data is loaded).
     CodeMonkey data has a real last sign-in, per-course progress and (with a roster) schools. */
  var SOURCES = {
    lms: {
      periodLabel: "ผู้เรียนที่ activate:",
      periods: function () { return [["", "ทั้งหมด"], ["2026-01-01", "ในปี 2569"], ["2026-09-07", "หลังประกาศผล (7 ก.ย. 69)"]]; },
      completeLabel: "เรียนจบแล้ว",
      bucketsTitle: "ระดับความคืบหน้าของผู้เรียน",
      monthlyTitle: "จำนวนผู้เรียนที่ activate รายเดือน",
      avgFoot: "ค่าเฉลี่ยการดูวิดีโอ",
      ongoingFoot: "ความคืบหน้ายังไม่ถึง 100%",
      foot: "ข้อมูลจากระบบ LMS",
      notes: null  // keep the notes written in index.html
    },
    codemonkey: {
      periodLabel: "เข้าใช้งานล่าสุด:",
      periods: function () { return [["", "ทั้งหมด"], [daysAgo(7), "ภายใน 7 วัน"], [daysAgo(30), "ภายใน 30 วัน"]]; },
      completeLabel: function () { return "จบ " + mainShort() + " แล้ว"; },
      bucketsTitle: function () { return "ระดับความคืบหน้าของผู้เรียน (" + snap.courses[0].label + ")"; },
      monthlyTitle: "การเข้าใช้งานล่าสุด รายเดือน",
      avgFoot: function () { return "ค่าเฉลี่ยความคืบหน้า " + mainShort(); },
      ongoingFoot: function () { return "ยังไม่จบ " + mainShort(); },
      foot: "ข้อมูลจาก CodeMonkey",
      notes: function () {
        return [
          "ข้อมูลจากระบบ CodeMonkey โดยตรง อัปเดตอัตโนมัติทุกชั่วโมง",
          "<strong>ความคืบหน้า</strong> = เปอร์เซ็นต์ที่ทำได้ในแต่ละคอร์ส: " +
            snap.courses.map(function (c) { return esc(c.label); }).join(", ") + " · ตัวเลขหลักและสถานะ \"จบ\" ใช้ " + esc(snap.courses[0].label) + " ซึ่งผู้เรียนเกือบทั้งหมดกำลังเรียนอยู่",
          "<strong>เข้าใช้งานล่าสุด</strong> = ครั้งล่าสุดที่ผู้เรียนเข้าสู่ระบบ CodeMonkey",
          hasRoster ? "ข้อมูลโรงเรียนและจังหวัดจับคู่จากรายชื่อนักเรียนของโครงการ" : ""
        ].filter(Boolean);
      }
    }
  };

  function $(id) { return document.getElementById(id); }
  function num(n) { return n.toLocaleString("th-TH"); }
  function pct(n) { return (Math.round(n * 10) / 10).toLocaleString("th-TH") + "%"; }
  function parseDay(s) { var p = s.slice(0, 10).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function ymd(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function daysAgo(n) { var d = parseDay(snap.generated_at); d.setDate(d.getDate() - n); return ymd(d); }
  function shortLabel(c) { return c.short || c.label; }
  function mainShort() { return shortLabel(snap.courses[0]); }
  function val(x) { return typeof x === "function" ? x() : x; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function when(s) {
    return s ? parseDay(s).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) + " " + s.slice(11, 16) + " น." : "—";
  }
  // LMS: finished = 100% of the videos. CodeMonkey: finished part 1 (where almost all learners are).
  function isDone(l) { return cm ? l[PARTS] >= 100 : l[P] >= 100; }
  function statusText(l) {
    if (!cm) return l[P] >= 100 ? "เรียนจบแล้ว" : "กำลังเรียน";
    for (var i = snap.courses.length - 1; i >= 0; i--) if (l[PARTS + i] >= 100) return "จบ " + shortLabel(snap.courses[i]);
    return "กำลังเรียน";
  }

  /* ---------- data ---------- */
  function load() {
    return fetch(DATA_URL, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function () {
        $("sampleNotice").hidden = false;
        return fetch(FALLBACK_URL, { cache: "no-store" }).then(function (r) { return r.json(); });
      });
  }
  function rows() {
    var from = state.from;
    return snap.learners.filter(function (l) { return !from || (l[W] || "") >= from; });
  }

  /* ---------- KPIs ---------- */
  function renderKPIs(list) {
    var done = 0, sum = 0;
    list.forEach(function (l) {
      sum += Math.min(l[P], 100);
      if (isDone(l)) done++;
    });
    var n = list.length;
    $("kpiLearners").textContent = num(n);
    $("kpiComplete").textContent = num(done);
    $("kpiCompleteFoot").textContent = n ? pct(done / n * 100) + " ของผู้เรียน" : "—";
    $("kpiAvg").textContent = n ? pct(sum / n) : "—";
    $("kpiOngoing").textContent = num(n - done);
  }

  /* ---------- charts ---------- */
  var BUCKETS = [
    { label: "0–24%", max: 24, color: "#dc2626" },
    { label: "25–49%", max: 49, color: "#f59e0b" },
    { label: "50–74%", max: 74, color: "#0891b2" },
    { label: "75–99%", max: 99, color: "#2563eb" },
    { label: "จบแล้ว (100%)", max: Infinity, color: "#16a34a" }
  ];
  function baseOpts(o) {
    var f = { family: "'Noto Sans Thai', sans-serif" };
    return { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: !!o.legend, position: "bottom", labels: { font: f, boxWidth: 12 } },
        tooltip: { bodyFont: f, titleFont: f } },
      scales: {
        x: { stacked: !!o.stacked, ticks: { font: f }, grid: { display: false } },
        y: { stacked: !!o.stacked, ticks: { font: f, precision: 0 }, beginAtZero: true } } };
  }
  function monthKeys(list) {
    var dated = list.map(function (l) { return l[W]; }).filter(Boolean).sort();
    if (!dated.length) return [];
    var keys = [], d = parseDay(dated[0].slice(0, 7) + "-01"), end = dated[dated.length - 1].slice(0, 7);
    for (;;) {
      var k = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
      keys.push(k);
      if (k >= end) return keys;
      d.setMonth(d.getMonth() + 1);
    }
  }
  function monthLabel(k) { return parseDay(k + "-01").toLocaleDateString("th-TH", { month: "short", year: "2-digit" }); }

  function renderCharts(list) {
    var counts = BUCKETS.map(function () { return 0; });
    list.forEach(function (l) {
      for (var i = 0; i < BUCKETS.length; i++) if (l[P] <= BUCKETS[i].max) { counts[i]++; break; }
    });
    var keys = monthKeys(list), idx = {}, done = [], ongoing = [];
    keys.forEach(function (k, i) { idx[k] = i; done.push(0); ongoing.push(0); });
    list.forEach(function (l) { if (l[W]) (isDone(l) ? done : ongoing)[idx[l[W].slice(0, 7)]]++; });

    if (charts.buckets) charts.buckets.destroy();
    if (charts.monthly) charts.monthly.destroy();
    charts.buckets = new Chart($("chartBuckets"), {
      type: "bar",
      data: { labels: BUCKETS.map(function (b) { return b.label; }),
        datasets: [{ label: "ผู้เรียน", data: counts, backgroundColor: BUCKETS.map(function (b) { return b.color; }) }] },
      options: baseOpts({})
    });
    charts.monthly = new Chart($("chartMonthly"), {
      type: "bar",
      data: { labels: keys.map(monthLabel), datasets: [
        { label: cm ? "จบ " + mainShort() + " แล้ว" : "เรียนจบแล้ว", data: done, backgroundColor: "#16a34a" },
        { label: cm ? "ยังไม่จบ " + mainShort() : "ยังไม่จบ", data: ongoing, backgroundColor: "#93c5fd" }] },
      options: baseOpts({ legend: true, stacked: true })
    });
  }

  /* ---------- filters ---------- */
  function options(values, all) {
    return '<option value="">' + all + "</option>" + values.map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(v) + "</option>";
    }).join("");
  }
  function uniqueSorted(list, col) {
    var set = {};
    list.forEach(function (l) { if (l[col]) set[l[col]] = true; });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, "th"); });
  }
  function buildPlaceFilters() {
    $("provinceFilter").hidden = $("schoolFilter").hidden = !hasRoster;
    if (!hasRoster) return;
    $("provinceFilter").innerHTML = options(uniqueSorted(snap.learners, V), "ทุกจังหวัด");
    buildSchoolFilter();
  }
  function buildSchoolFilter() {
    var prov = state.prov;
    var schools = uniqueSorted(snap.learners.filter(function (l) { return !prov || l[V] === prov; }), S);
    if (schools.indexOf(state.school) === -1) state.school = "";
    $("schoolFilter").innerHTML = options(schools, "ทุกโรงเรียน");
    $("schoolFilter").value = state.school;
  }

  /* ---------- table ---------- */
  function highlight(text, q) {
    text = String(text == null ? "" : text);
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  var SORTS = {
    "pct-desc": function (a, b) { return b[P] - a[P] || cmp(a[N] || "", b[N] || ""); },
    "pct-asc": function (a, b) { return a[P] - b[P] || cmp(a[N] || "", b[N] || ""); },
    "recent": function (a, b) { return cmp(b[W] || "", a[W] || ""); },
    "name": function (a, b) { return (a[N] || "").localeCompare(b[N] || "", "th"); },
    "school": function (a, b) { return (a[S] || "￿").localeCompare(b[S] || "￿", "th") || (a[N] || "").localeCompare(b[N] || "", "th"); }
  };
  function bar(p, done, small) {
    return '<div class="progress-cell"><div class="bar' + (small ? " sm" : "") + (done ? " done" : "") + '"><span style="width:' + p + '%"></span></div>' +
      '<span class="progress-num">' + p + "%</span></div>";
  }
  function columns() {
    var cols = ['<th class="col-idx">ลำดับ</th>', "<th>ชื่อ - นามสกุล</th>"];
    if (hasRoster) cols.push("<th>โรงเรียน</th>", "<th>จังหวัด</th>");
    if (cm) snap.courses.forEach(function (c) { cols.push('<th class="part-cell">' + esc(c.label) + "</th>"); });
    else cols.push('<th class="col-progress">ความคืบหน้า</th>');
    cols.push("<th>สถานะ</th>");
    if (cm) cols.push("<th>เข้าใช้งานล่าสุด</th>");
    return cols;
  }
  function renderTable(list) {
    var q = state.q, status = state.status;
    var shown = list.filter(function (l) {
      if (status === "done" && !isDone(l)) return false;
      if (status === "ongoing" && isDone(l)) return false;
      if (state.prov && l[V] !== state.prov) return false;
      if (state.school && l[S] !== state.school) return false;
      return !q || [l[N], l[S], l[V]].some(function (v) { return (v || "").toLowerCase().indexOf(q) !== -1; });
    }).sort(SORTS[state.sort]);
    state.shown = shown;
    var html = shown.map(function (l, i) {
      var cells = ['<td class="idx">' + (i + 1) + "</td>", '<td class="name">' + highlight(l[N] || "—", q) + "</td>"];
      if (hasRoster) {
        cells.push(l[S] ? "<td>" + highlight(l[S], q) + "</td>" : '<td class="muted">ไม่พบข้อมูล</td>');
        cells.push("<td>" + highlight(l[V] || "", q) + "</td>");
      }
      if (cm) snap.courses.forEach(function (c, k) { var p = l[PARTS + k] || 0; cells.push('<td class="part-cell">' + bar(p, p >= 100, true) + "</td>"); });
      else cells.push("<td>" + bar(Math.min(l[P], 100), l[P] >= 100) + "</td>");
      cells.push("<td>" + (isDone(l) ? '<span class="pill full">' : '<span class="pill ongoing">') + esc(statusText(l)) + "</span></td>");
      if (cm) cells.push('<td class="when">' + esc(when(l[W])) + "</td>");
      return "<tr>" + cells.join("") + "</tr>";
    }).join("");
    $("tableBody").innerHTML = html || '<tr><td class="empty" colspan="' + columns().length + '">ไม่พบรายชื่อที่ตรงกับการค้นหา</td></tr>';
    $("rowCount").textContent = "แสดง " + num(shown.length) + " จาก " + num(list.length) + " รายชื่อ";
  }

  /* ---------- export ---------- */
  function exportCSV() {
    var head = ["ลำดับ", "ชื่อ - นามสกุล"];
    if (hasRoster) head.push("โรงเรียน", "จังหวัด");
    if (cm) snap.courses.forEach(function (c) { head.push(c.label + " (%)"); });
    else head.push("ความคืบหน้า (%)");
    head.push("สถานะ");
    if (cm) head.push("เข้าใช้งานล่าสุด");
    var lines = [head].concat(state.shown.map(function (l, i) {
      var row = [i + 1, l[N]];
      if (hasRoster) row.push(l[S], l[V]);
      if (cm) snap.courses.forEach(function (c, k) { row.push(l[PARTS + k] || 0); });
      else row.push(Math.min(l[P], 100));
      row.push(statusText(l));
      if (cm) row.push(l[W]);
      return row;
    }));
    var csv = lines.map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "code-monkey-progress.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function render() {
    var list = rows();
    renderKPIs(list);
    renderCharts(list);
    renderTable(list);
  }

  /* ---------- per-source setup ---------- */
  function applySource() {
    var src = SOURCES[cm ? "codemonkey" : "lms"];
    $("reviewNotice").hidden = cm;
    $("periodLabel").textContent = src.periodLabel;
    $("periodSeg").innerHTML = src.periods().map(function (p, i) {
      return '<button type="button" data-from="' + p[0] + '" aria-pressed="' + (i === 0) + '">' + esc(p[1]) + "</button>";
    }).join("");
    $("kpiCompleteLabel").textContent = val(src.completeLabel);
    $("bucketsTitle").textContent = val(src.bucketsTitle);
    $("monthlyTitle").textContent = val(src.monthlyTitle);
    $("kpiAvgFoot").textContent = val(src.avgFoot);
    $("kpiOngoingFoot").textContent = val(src.ongoingFoot);
    $("footSource").textContent = src.foot;
    if (src.notes) $("notesList").innerHTML = src.notes().map(function (n) { return "<li>" + n + "</li>"; }).join("");
    $("statusFilter").options[1].textContent = val(src.completeLabel);
    if (cm && !$("sortBy").querySelector('option[value="recent"]')) {
      $("sortBy").insertAdjacentHTML("beforeend", '<option value="recent">เข้าใช้งานล่าสุด</option>');
    }
    if (hasRoster) {
      $("sortBy").insertAdjacentHTML("beforeend", '<option value="school">โรงเรียน ก → ฮ</option>');
      $("searchBox").placeholder = "🔍 ค้นหาชื่อ นร. / โรงเรียน / จังหวัด…";
    }
    $("tableHead").innerHTML = columns().join("");
    buildPlaceFilters();
  }

  /* ---------- init ---------- */
  $("periodSeg").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    Array.prototype.forEach.call(this.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
    state.from = btn.getAttribute("data-from");
    render();
  });
  $("searchBox").addEventListener("input", function (e) { state.q = (e.target.value || "").trim().toLowerCase(); renderTable(rows()); });
  $("provinceFilter").addEventListener("change", function (e) { state.prov = e.target.value; buildSchoolFilter(); renderTable(rows()); });
  $("schoolFilter").addEventListener("change", function (e) { state.school = e.target.value; renderTable(rows()); });
  $("statusFilter").addEventListener("change", function (e) { state.status = e.target.value; renderTable(rows()); });
  $("sortBy").addEventListener("change", function (e) { state.sort = e.target.value; renderTable(rows()); });
  $("exportBtn").addEventListener("click", exportCSV);

  load().then(function (data) {
    snap = data;
    cm = data.source === "codemonkey";
    hasRoster = cm && data.learners.some(function (l) { return l[S] || l[V]; });
    $("updatedAt").textContent = "อัปเดตล่าสุด " + parseDay(data.generated_at.slice(0, 10))
      .toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) + " " + data.generated_at.slice(11, 16) + " น.";
    if (data.lessons) $("lessonCount").textContent = data.lessons;
    applySource();
    render();
  }).catch(function () {
    $("updatedAt").textContent = "โหลดข้อมูลไม่สำเร็จ";
  });
})();

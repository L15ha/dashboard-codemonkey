/* Code Monkey — course progress dashboard. LMS snapshot from data/progress.json:
   learners = [[last_activity "YYYY-MM-DD HH:MM", avg_watch_percent, name], ...] */
(function () {
  "use strict";

  var DATA_URL = "data/progress.json";      // served by nginx from /var/lib/codemonkey (see deploy/)
  var FALLBACK_URL = "data/sample.json";    // synthetic data for local preview
  var IDLE_DAYS = 30;

  var snap = null;
  var charts = {};
  var state = { from: "", q: "", status: "", sort: "pct-desc", shown: [] };

  function $(id) { return document.getElementById(id); }
  function num(n) { return n.toLocaleString("th-TH"); }
  function pct(n) { return (Math.round(n * 10) / 10).toLocaleString("th-TH") + "%"; }
  function parseDay(s) { var p = s.slice(0, 10).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function when(s) {
    return parseDay(s).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) +
      (s.length > 10 ? " " + s.slice(11, 16) + " น." : "");
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
    return snap.learners.filter(function (l) { return !from || l[0] >= from; });
  }

  /* ---------- KPIs ---------- */
  function renderKPIs(list) {
    var done = 0, sum = 0, idle = 0;
    var cutoff = parseDay(snap.generated_at.slice(0, 10));
    cutoff.setDate(cutoff.getDate() - IDLE_DAYS);
    list.forEach(function (l) {
      sum += Math.min(l[1], 100);
      if (l[1] >= 100) done++;
      else if (parseDay(l[0]) < cutoff) idle++;
    });
    var n = list.length;
    $("kpiLearners").textContent = num(n);
    $("kpiComplete").textContent = num(done);
    $("kpiCompleteFoot").textContent = n ? pct(done / n * 100) + " ของผู้เรียน" : "—";
    $("kpiAvg").textContent = n ? pct(sum / n) : "—";
    $("kpiIdle").textContent = num(idle);
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
    if (!list.length) return [];
    var keys = [], d = parseDay(list[0][0].slice(0, 7) + "-01"), end = list[list.length - 1][0].slice(0, 7);
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
      for (var i = 0; i < BUCKETS.length; i++) if (l[1] <= BUCKETS[i].max) { counts[i]++; break; }
    });
    var keys = monthKeys(list), idx = {}, done = [], ongoing = [];
    keys.forEach(function (k, i) { idx[k] = i; done.push(0); ongoing.push(0); });
    list.forEach(function (l) { (l[1] >= 100 ? done : ongoing)[idx[l[0].slice(0, 7)]]++; });

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
        { label: "เรียนจบแล้ว", data: done, backgroundColor: "#16a34a" },
        { label: "ยังไม่จบ", data: ongoing, backgroundColor: "#93c5fd" }] },
      options: baseOpts({ legend: true, stacked: true })
    });
  }

  /* ---------- table ---------- */
  function highlight(text, q) {
    text = String(text == null ? "" : text);
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  var SORTS = {
    "pct-desc": function (a, b) { return b[1] - a[1] || (b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0); },
    "pct-asc": function (a, b) { return a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); },
    "recent": function (a, b) { return b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0; },
    "name": function (a, b) { return (a[2] || "").localeCompare(b[2] || "", "th"); }
  };
  function renderTable(list) {
    var q = state.q, status = state.status;
    var shown = list.filter(function (l) {
      if (status === "done" && l[1] < 100) return false;
      if (status === "ongoing" && l[1] >= 100) return false;
      return !q || (l[2] || "").toLowerCase().indexOf(q) !== -1;
    }).sort(SORTS[state.sort]);
    state.shown = shown;
    var html = shown.map(function (l, i) {
      var p = Math.min(l[1], 100), done = l[1] >= 100;
      return "<tr>" +
        '<td class="idx">' + (i + 1) + "</td>" +
        '<td class="name">' + highlight(l[2] || "—", q) + "</td>" +
        '<td><div class="progress-cell"><div class="bar' + (done ? " done" : "") + '"><span style="width:' + p + '%"></span></div>' +
          '<span class="progress-num">' + p + "%</span></div></td>" +
        "<td>" + (done ? '<span class="pill full">เรียนจบแล้ว</span>' : '<span class="pill ongoing">กำลังเรียน</span>') + "</td>" +
        '<td class="when">' + esc(when(l[0])) + "</td>" +
      "</tr>";
    }).join("");
    $("tableBody").innerHTML = html || '<tr><td class="empty" colspan="5">ไม่พบรายชื่อที่ตรงกับการค้นหา</td></tr>';
    $("rowCount").textContent = "แสดง " + num(shown.length) + " จาก " + num(list.length) + " รายชื่อ";
  }

  /* ---------- export ---------- */
  function exportCSV() {
    var head = ["ลำดับ", "ชื่อ - นามสกุล", "ความคืบหน้า (%)", "สถานะ", "เข้าเรียนล่าสุด"];
    var lines = [head].concat(state.shown.map(function (l, i) {
      return [i + 1, l[2], Math.min(l[1], 100), l[1] >= 100 ? "เรียนจบแล้ว" : "กำลังเรียน", l[0]];
    }));
    var csv = lines.map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
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

  /* ---------- init ---------- */
  $("periodSeg").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    Array.prototype.forEach.call(this.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
    state.from = btn.getAttribute("data-from");
    render();
  });
  $("searchBox").addEventListener("input", function (e) { state.q = (e.target.value || "").trim().toLowerCase(); renderTable(rows()); });
  $("statusFilter").addEventListener("change", function (e) { state.status = e.target.value; renderTable(rows()); });
  $("sortBy").addEventListener("change", function (e) { state.sort = e.target.value; renderTable(rows()); });
  $("exportBtn").addEventListener("click", exportCSV);

  load().then(function (data) {
    snap = data;
    $("updatedAt").textContent = "อัปเดตล่าสุด " + parseDay(data.generated_at.slice(0, 10))
      .toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) + " " + data.generated_at.slice(11, 16) + " น.";
    if (data.lessons) $("lessonCount").textContent = data.lessons;
    render();
  }).catch(function () {
    $("updatedAt").textContent = "โหลดข้อมูลไม่สำเร็จ";
  });
})();

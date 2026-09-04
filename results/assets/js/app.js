/* Code Monkey — winners announcement dashboard. Static data from data.js. */
(function () {
  "use strict";

  var ALL = (window.WINNERS || []).slice();
  var charts = {};
  var state = { filtered: ALL.slice(), q: "", prov: "" };

  var PROVINCE_ALIASES = {
    "กรุงเทพ": "กรุงเทพมหานคร", "กรุงเทพฯ": "กรุงเทพมหานคร",
    "กทม.": "กรุงเทพมหานคร", "กทม": "กรุงเทพมหานคร",
    "Bangkok": "กรุงเทพมหานคร", "สุราษฏร์ธานี": "สุราษฎร์ธานี"
  };
  function normProv(v) { var s = (v || "").trim(); return PROVINCE_ALIASES[s] || s; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  /* ---------- KPIs ---------- */
  function renderKPIs() {
    var seats = 0, teacher = 0, student = 0, provs = {}, schools = {};
    ALL.forEach(function (r) {
      seats += r.seats || 0; teacher += r.teacher || 0; student += r.student || 0;
      provs[normProv(r.province)] = true;
      schools[(r.school || "").trim()] = true;
    });
    $("kpiWinners").textContent = ALL.length.toLocaleString("th-TH");
    $("kpiSeats").textContent = seats.toLocaleString("th-TH");
    $("kpiSplit").textContent = "ครู " + teacher.toLocaleString("th-TH") + " · นักเรียน " + student.toLocaleString("th-TH");
    $("kpiSchools").textContent = Object.keys(schools).filter(Boolean).length.toLocaleString("th-TH");
    $("kpiProvinces").textContent = Object.keys(provs).filter(Boolean).length.toLocaleString("th-TH");
  }

  /* ---------- filter dropdown ---------- */
  function buildProvinceFilter() {
    var set = {};
    ALL.forEach(function (r) { set[normProv(r.province)] = true; });
    var provs = Object.keys(set).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, "th"); });
    $("provinceFilter").innerHTML = '<option value="">ทุกจังหวัด</option>' +
      provs.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }).join("");
  }

  /* ---------- table ---------- */
  function highlight(text, q) {
    text = String(text == null ? "" : text);
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function statusPill(s) {
    var cls = /บางส่วน/.test(s) ? "partial" : "full";
    return '<span class="pill ' + cls + '">' + esc(s) + "</span>";
  }
  function applyFilter() {
    var q = state.q, prov = state.prov;
    state.filtered = ALL.filter(function (r) {
      if (prov && normProv(r.province) !== prov) return false;
      if (!q) return true;
      return (r.name || "").toLowerCase().indexOf(q) !== -1 ||
             (r.school || "").toLowerCase().indexOf(q) !== -1 ||
             (r.province || "").toLowerCase().indexOf(q) !== -1;
    });
    renderTable();
  }
  function renderTable() {
    var q = state.q;
    var html = state.filtered.map(function (r, i) {
      return "<tr>" +
        '<td class="idx">' + (i + 1) + "</td>" +
        '<td class="name">' + highlight(r.name, q) + "</td>" +
        "<td>" + highlight(r.school, q) + "</td>" +
        "<td>" + highlight(r.province, q) + "</td>" +
        "<td>" + statusPill(r.status) + "</td>" +
      "</tr>";
    }).join("");
    $("tableBody").innerHTML = html || '<tr><td class="empty" colspan="5">ไม่พบรายชื่อที่ตรงกับการค้นหา</td></tr>';
    $("rowCount").textContent = "แสดง " + state.filtered.length.toLocaleString("th-TH") +
      " จาก " + ALL.length.toLocaleString("th-TH") + " รายชื่อ";
  }

  /* ---------- charts ---------- */
  var PALETTE = ["#2563eb","#16a34a","#f59e0b","#db2777","#7c3aed","#0891b2","#dc2626","#65a30d","#ea580c","#4f46e5"];
  function baseOpts(o) {
    var f = { family: "'Noto Sans Thai', sans-serif" };
    return { responsive: true, maintainAspectRatio: false, indexAxis: o.indexAxis || "x",
      plugins: { legend: { display: !!o.legend, position: "bottom", labels: { font: f, boxWidth: 12 } },
        tooltip: { bodyFont: f, titleFont: f } },
      scales: o.legend ? {} : {
        x: { ticks: { font: f }, grid: { display: o.indexAxis === "y" } },
        y: { ticks: { font: f }, grid: { display: o.indexAxis !== "y" }, beginAtZero: true } } };
  }
  function shorten(s) { s = String(s || ""); return s.length > 24 ? s.slice(0, 23) + "…" : s; }
  function renderCharts() {
    var byProv = {}, byAff = {};
    ALL.forEach(function (r) {
      var p = normProv(r.province) || "ไม่ระบุ"; byProv[p] = (byProv[p] || 0) + 1;
      var a = (r.affiliation || "ไม่ระบุ").trim() || "ไม่ระบุ"; byAff[a] = (byAff[a] || 0) + 1;
    });
    var top = Object.keys(byProv).map(function (k) { return [k, byProv[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    charts.prov = new Chart($("chartProvince"), {
      type: "bar",
      data: { labels: top.map(function (x) { return x[0]; }),
        datasets: [{ label: "ผู้ได้รับสิทธิ์", data: top.map(function (x) { return x[1]; }), backgroundColor: "#2563eb" }] },
      options: baseOpts({ indexAxis: "y" })
    });
    var aff = Object.keys(byAff);
    charts.aff = new Chart($("chartAffiliation"), {
      type: "doughnut",
      data: { labels: aff.map(shorten), datasets: [{ data: aff.map(function (k) { return byAff[k]; }), backgroundColor: PALETTE }] },
      options: baseOpts({ legend: true })
    });
  }

  /* ---------- export ---------- */
  function exportCSV() {
    var head = ["ลำดับ", "ชื่อ - นามสกุล", "ชื่อสถานศึกษา", "จังหวัด", "สถานะผลคัดเลือก"];
    var lines = [head].concat(state.filtered.map(function (r, i) {
      return [i + 1, r.name, r.school, r.province, r.status];
    }));
    var csv = lines.map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "code-monkey-winners.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  /* ---------- init ---------- */
  $("searchBox").addEventListener("input", function (e) { state.q = (e.target.value || "").trim().toLowerCase(); applyFilter(); });
  $("provinceFilter").addEventListener("change", function (e) { state.prov = e.target.value; applyFilter(); });
  $("exportBtn").addEventListener("click", exportCSV);

  renderKPIs();
  buildProvinceFilter();
  renderCharts();
  renderTable();
})();

/* Code Monkey approval dashboard — data load, transform, render. */
(function () {
  "use strict";

  var CFG = window.DASHBOARD_CONFIG;
  var STATUS = CFG.APPROVAL_STATUS;
  var HEADERS = CFG.COLUMNS.concat(["สถานะการอนุมัติ"]);
  var charts = {};
  var state = { rows: [], filtered: [], sortIdx: null, sortDir: 1 };

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }

  function normProvince(v) {
    var s = (v || "").trim();
    return CFG.PROVINCE_ALIASES[s] || s;
  }

  function toNumber(v) {
    if (v == null) return 0;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showBanner(msg, kind) {
    var b = $("statusBanner");
    b.textContent = msg;
    b.className = "banner " + (kind || "info");
    b.hidden = false;
  }
  function hideBanner() { $("statusBanner").hidden = true; }

  /* ---------- data loading ---------- */
  function load() {
    $("refreshBtn").disabled = true;
    $("lastUpdated").textContent = "กำลังโหลด…";
    var url = CFG.DATA_CSV_URL;
    var usingLive = url && url.indexOf("__") !== 0;
    // Cache-bust the live feed so the browser always fetches Google's latest
    // published snapshot rather than a cached copy.
    var target = usingLive
      ? url + (url.indexOf("?") > -1 ? "&" : "?") + "_=" + Date.now()
      : CFG.FALLBACK_CSV_URL;

    Papa.parse(target, {
      download: true,
      skipEmptyLines: true,
      // cache-bust so refresh always pulls the latest published data
      downloadRequestHeaders: undefined,
      complete: function (res) {
        try {
          var rows = (res.data || []).filter(function (r) {
            return r && r.length && String(r[CFG.IDX.SCHOOL] || "").trim() !== "";
          });
          if (!rows.length) {
            if (usingLive) return fail("ยังไม่มีข้อมูลจากชีต หรือชีตยังไม่ได้เผยแพร่");
            return setupHint();
          }
          state.rows = rows;
          hideBanner();
          render();
          var when = new Date();
          $("lastUpdated").textContent = "อัปเดตล่าสุด " + when.toLocaleString("th-TH");
        } catch (e) {
          fail("เกิดข้อผิดพลาดในการประมวลผลข้อมูล: " + e.message);
        } finally {
          $("refreshBtn").disabled = false;
        }
      },
      error: function () {
        $("refreshBtn").disabled = false;
        if (usingLive) fail("ไม่สามารถดึงข้อมูลจากชีตได้ กรุณาตรวจสอบการเผยแพร่ (Publish to web)");
        else setupHint();
      }
    });
  }

  function fail(msg) { showBanner("⚠ " + msg, "error"); $("lastUpdated").textContent = "โหลดไม่สำเร็จ"; }

  function setupHint() {
    showBanner("ยังไม่ได้ตั้งค่าแหล่งข้อมูลสด — เปิดไฟล์ assets/js/config.js แล้วใส่ลิงก์ CSV จาก 'เผยแพร่ไปยังเว็บ' ของแท็บ Dashboard", "info");
    $("lastUpdated").textContent = "รอการตั้งค่า";
  }

  /* ---------- rendering ---------- */
  function render() {
    buildProvinceFilter();
    applyFilter();
    renderKPIs();
    renderCharts();
  }

  function buildProvinceFilter() {
    var sel = $("provinceFilter");
    var current = sel.value;
    var set = {};
    state.rows.forEach(function (r) { set[normProvince(r[CFG.IDX.PROVINCE])] = true; });
    var provs = Object.keys(set).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, "th"); });
    sel.innerHTML = '<option value="">ทุกจังหวัด</option>' +
      provs.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }).join("");
    sel.value = current;
  }

  function applyFilter() {
    var q = ($("searchBox").value || "").trim().toLowerCase();
    var prov = $("provinceFilter").value;
    state.filtered = state.rows.filter(function (r) {
      if (prov && normProvince(r[CFG.IDX.PROVINCE]) !== prov) return false;
      if (!q) return true;
      return r.some(function (c) { return String(c || "").toLowerCase().indexOf(q) !== -1; });
    });
    if (state.sortIdx != null) {
      var i = state.sortIdx, dir = state.sortDir;
      state.filtered.sort(function (a, b) {
        var av = a[i], bv = b[i];
        if (i === CFG.IDX.SEATS) return (toNumber(av) - toNumber(bv)) * dir;
        return String(av || "").localeCompare(String(bv || ""), "th") * dir;
      });
    }
    renderTable();
  }

  function renderKPIs() {
    var schools = state.rows.length;
    var seats = state.rows.reduce(function (s, r) { return s + toNumber(r[CFG.IDX.SEATS]); }, 0);
    var provs = {};
    state.rows.forEach(function (r) { provs[normProvince(r[CFG.IDX.PROVINCE])] = true; });
    $("kpiSchools").textContent = schools.toLocaleString("th-TH");
    $("kpiSeats").textContent = seats.toLocaleString("th-TH");
    $("kpiProvinces").textContent = Object.keys(provs).filter(Boolean).length.toLocaleString("th-TH");
    $("kpiPending").textContent = schools.toLocaleString("th-TH");
  }

  function renderTable() {
    var head = $("tableHead");
    head.innerHTML = HEADERS.map(function (h, i) {
      var arrow = state.sortIdx === i ? (state.sortDir === 1 ? " ▲" : " ▼") : "";
      return '<th data-i="' + i + '" class="sortable">' + esc(h) + arrow + "</th>";
    }).join("");
    Array.prototype.forEach.call(head.querySelectorAll("th"), function (th) {
      th.addEventListener("click", function () {
        var i = +th.getAttribute("data-i");
        if (i >= CFG.COLUMNS.length) return; // status column not sortable
        if (state.sortIdx === i) state.sortDir *= -1; else { state.sortIdx = i; state.sortDir = 1; }
        applyFilter();
      });
    });

    var body = $("tableBody");
    var html = state.filtered.map(function (r) {
      var cells = CFG.COLUMNS.map(function (_, i) {
        var v = r[i];
        if (i === CFG.IDX.SEATS) return '<td class="num">' + esc(toNumber(v).toLocaleString("th-TH")) + "</td>";
        return "<td>" + esc(v) + "</td>";
      }).join("");
      cells += '<td><span class="pill pending">' + esc(STATUS) + "</span></td>";
      return "<tr>" + cells + "</tr>";
    }).join("");
    body.innerHTML = html || '<tr><td colspan="' + HEADERS.length + '" class="empty">ไม่พบข้อมูลที่ตรงกับการค้นหา</td></tr>';
    $("rowCount").textContent = "แสดง " + state.filtered.length.toLocaleString("th-TH") +
      " จาก " + state.rows.length.toLocaleString("th-TH") + " รายการ";
  }

  /* ---------- charts ---------- */
  var PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#65a30d", "#ea580c", "#4f46e5"];

  function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

  function renderCharts() {
    var byProvSeats = {}, byAff = {}, byGrade = {};
    state.rows.forEach(function (r) {
      var p = normProvince(r[CFG.IDX.PROVINCE]) || "ไม่ระบุ";
      byProvSeats[p] = (byProvSeats[p] || 0) + toNumber(r[CFG.IDX.SEATS]);
      var a = (r[CFG.IDX.AFFILIATION] || "ไม่ระบุ").trim() || "ไม่ระบุ";
      byAff[a] = (byAff[a] || 0) + 1;
      String(r[CFG.IDX.GRADE] || "").split(",").forEach(function (g) {
        g = g.trim(); if (!g) return; byGrade[g] = (byGrade[g] || 0) + 1;
      });
    });

    var provTop = Object.keys(byProvSeats).map(function (k) { return [k, byProvSeats[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);

    destroy("prov");
    charts.prov = new Chart($("chartProvince"), {
      type: "bar",
      data: { labels: provTop.map(function (x) { return x[0]; }),
        datasets: [{ label: "จำนวนที่ขออนุมัติสิทธิ", data: provTop.map(function (x) { return x[1]; }), backgroundColor: "#2563eb" }] },
      options: baseOpts({ indexAxis: "y" })
    });

    destroy("aff");
    var affKeys = Object.keys(byAff);
    charts.aff = new Chart($("chartAffiliation"), {
      type: "doughnut",
      data: { labels: affKeys.map(shorten), datasets: [{ data: affKeys.map(function (k) { return byAff[k]; }), backgroundColor: PALETTE }] },
      options: baseOpts({ legend: true })
    });

    destroy("grade");
    var gradeKeys = Object.keys(byGrade);
    charts.grade = new Chart($("chartGrade"), {
      type: "bar",
      data: { labels: gradeKeys.map(shorten), datasets: [{ label: "จำนวนโรงเรียน", data: gradeKeys.map(function (k) { return byGrade[k]; }), backgroundColor: "#16a34a" }] },
      options: baseOpts({})
    });

    destroy("status");
    charts.status = new Chart($("chartStatus"), {
      type: "doughnut",
      data: { labels: [STATUS], datasets: [{ data: [state.rows.length], backgroundColor: ["#f59e0b"] }] },
      options: baseOpts({ legend: true })
    });
  }

  function shorten(s) { s = String(s || ""); return s.length > 22 ? s.slice(0, 21) + "…" : s; }

  function baseOpts(o) {
    var f = { family: "'Noto Sans Thai', sans-serif" };
    return {
      responsive: true, maintainAspectRatio: false,
      indexAxis: o.indexAxis || "x",
      plugins: {
        legend: { display: !!o.legend, position: "bottom", labels: { font: f, boxWidth: 12 } },
        tooltip: { bodyFont: f, titleFont: f }
      },
      scales: (o.legend) ? {} : {
        x: { ticks: { font: f }, grid: { display: o.indexAxis === "y" } },
        y: { ticks: { font: f }, grid: { display: o.indexAxis !== "y" }, beginAtZero: true }
      }
    };
  }

  /* ---------- export ---------- */
  function exportCSV() {
    var rows = [HEADERS].concat(state.filtered.map(function (r) {
      var out = CFG.COLUMNS.map(function (_, i) { return r[i] == null ? "" : r[i]; });
      out.push(STATUS);
      return out;
    }));
    var csv = Papa.unparse(rows);
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "code-monkey-dashboard.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  /* ---------- wire up ---------- */
  $("refreshBtn").addEventListener("click", load);
  $("searchBox").addEventListener("input", applyFilter);
  $("provinceFilter").addEventListener("change", applyFilter);
  $("exportBtn").addEventListener("click", exportCSV);

  load();
})();

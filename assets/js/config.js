/*
 * Configuration for the Code Monkey approval dashboard.
 *
 * DATA_CSV_URL:
 *   The "Publish to web" CSV link of the *Dashboard* tab of the Google Sheet.
 *   That tab contains ONLY non-personal columns (no name / phone / email),
 *   so publishing it does not expose personally identifiable information.
 *   Format looks like:
 *     https://docs.google.com/spreadsheets/d/e/2PACX-XXXX/pub?gid=NNN&single=true&output=csv
 *
 *   Until it is filled in, the dashboard shows a friendly setup message.
 */
window.DASHBOARD_CONFIG = {
  // Filled automatically once the Dashboard tab is published to the web.
  DATA_CSV_URL: "__PUBLISHED_CSV_URL__",

  // Fallback CSV bundled with the app (used only if the live URL is unset/unreachable).
  FALLBACK_CSV_URL: "assets/data/sample.csv",

  // Constant approval status applied to every row.
  APPROVAL_STATUS: "อยู่ระหว่างพิจารณา",

  /*
   * The published Dashboard tab outputs these 12 columns, in this exact order
   * (produced by the QUERY that selects only non-PII columns). The app appends
   * the approval-status column as the 13th column.
   */
  COLUMNS: [
    "ชื่อสถานศึกษา",
    "จังหวัด",
    "อำเภอ/เขต",
    "ตำบล/แขวง",
    "จำนวนที่ขออนุมัติสิทธิ",
    "ระดับชั้นที่เข้าร่วมโครงการ",
    "สาขาวิชาที่สอน",
    "สังกัด",
    "ห้องเรียนคอมพิวเตอร์",
    "ปัญหาด้านอินเตอร์เน็ต",
    "ชั่วโมงกิจกรรมสอน coding",
    "ศูนย์ดิจิทัลชุมชน"
  ],

  // Column indexes used by charts / KPIs (0-based, within COLUMNS above).
  IDX: {
    SCHOOL: 0,
    PROVINCE: 1,
    DISTRICT: 2,
    SUBDISTRICT: 3,
    SEATS: 4,
    GRADE: 5,
    SUBJECT: 6,
    AFFILIATION: 7
  },

  // Normalise inconsistent province spellings so charts group them correctly.
  PROVINCE_ALIASES: {
    "กรุงเทพ": "กรุงเทพมหานคร",
    "กรุงเทพฯ": "กรุงเทพมหานคร",
    "กทม.": "กรุงเทพมหานคร",
    "กทม": "กรุงเทพมหานคร",
    "Bangkok": "กรุงเทพมหานคร",
    "สุราษฏร์ธานี": "สุราษฎร์ธานี"
  }
};

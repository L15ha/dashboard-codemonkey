# แดชบอร์ดโปรแกรม Code Monkey

เว็บ static (HTML/CSS/JS) มี 2 หน้า สลับกันได้จากแถบเมนูด้านบน:

- **ความคืบหน้าการเรียน** (`/progress/`) — หน้าแรก (`/` จะพาไปหน้านี้) สถิติ + รายชื่อผู้เรียนและ % ความคืบหน้า จาก LMS API ดูข้อ 5
- **ประกาศผลผู้ได้รับสิทธิ์** (`/results/`) — ข้อมูลรายชื่อฝังในไฟล์ `results/assets/js/data.js`

---

## โครงสร้างไฟล์

```
Dashboard Codemonkey/
├─ index.html                 หน้าแรก → พาไป progress/
├─ results/                   หน้าประกาศผล (index.html, assets/, vendor/)
├─ progress/                  หน้าความคืบหน้าการเรียน
│  ├─ assets/js/app.js
│  └─ data/sample.json        ข้อมูลสมมติ (ใช้ตอนรันในเครื่อง)
├─ vendor/chart.umd.js        Chart.js (self-host)
├─ deploy/                    สคริปต์ติดตั้ง + ตั้งค่าความปลอดภัยบน EC2 + sync ข้อมูล LMS
│  ├─ nginx.conf
│  ├─ setup-server.sh
│  ├─ harden.sh
│  ├─ deploy.sh
│  ├─ sync-progress.py
│  └─ install-progress-sync.sh
├─ .github/workflows/deploy.yml   auto-deploy ขึ้น EC2 เมื่อ push
└─ .gitignore
```

---

## 1) รันในเครื่อง (local)

เป็นเว็บ static เปิดด้วยเซิร์ฟเวอร์ไฟล์ธรรมดา:

```bash
# ใน VS Code: ใช้ส่วนขยาย "Live Server" กด Go Live
# หรือใช้ Python:
python3 -m http.server 8080
# เปิด http://localhost:8080
```

---

## 2) ขึ้น Git / GitHub

```bash
cd "Dashboard Codemonkey"
git init
git add .
git commit -m "Code Monkey approval dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/codemonkey-dashboard.git
git push -u origin main
```

> `.gitignore` กันไม่ให้ commit คีย์/ความลับ (`*.pem`, `*.key`, `.env`) โดยอัตโนมัติ

---

## 3) Deploy ขึ้น EC2 (พร้อม hardening ความปลอดภัย)

### 3.1 เตรียม EC2
- สร้าง instance **Ubuntu 22.04/24.04** (t3.micro พอ)
- **Security Group** เปิดเฉพาะ: `22 (SSH)`, `80 (HTTP)`, `443 (HTTPS)` — ปิดพอร์ตอื่นทั้งหมด
  - แนะนำให้จำกัด SSH (22) ให้เฉพาะ IP ของคุณ (`My IP`)
- ใช้ **key pair** สำหรับ SSH (ไม่ใช้รหัสผ่าน)
- (แนะนำ) ชี้ **โดเมน** มาที่ Public IP ของ instance เพื่อออกใบรับรอง HTTPS

### 3.2 ติดตั้ง
SSH เข้า instance แล้วดึงโค้ด:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/<your-username>/codemonkey-dashboard.git
cd codemonkey-dashboard

# ติดตั้ง + ออก HTTPS อัตโนมัติ (ต้องมีโดเมนชี้มาแล้ว)
sudo DOMAIN=dashboard.example.com EMAIL=you@example.com bash deploy/setup-server.sh
```

สคริปต์นี้จะ:
1. ติดตั้ง nginx, ตั้งค่า security headers + CSP + TLS ที่แข็งแรง
2. เอาไฟล์เว็บไปไว้ที่ `/var/www/codemonkey`
3. รัน `harden.sh`: เปิด **UFW firewall**, ตั้ง **fail2ban**, ล็อก **SSH (key-only, ปิด root)**, เปิด **auto security updates**
4. ออกใบรับรอง **Let's Encrypt** และบังคับ redirect ไป HTTPS

> ยังไม่มีโดเมน? รันโดยไม่ใส่ `DOMAIN` ได้ (จะเป็น HTTP ก่อน) แล้วค่อยรันซ้ำพร้อมโดเมนภายหลัง

### 3.3 อัปเดตครั้งถัดไป
```bash
cd codemonkey-dashboard && git pull && bash deploy/deploy.sh
```
หรือปล่อยให้ **GitHub Actions** deploy อัตโนมัติเมื่อ push (ดูข้อ 4)

---

## 4) Auto-deploy ด้วย GitHub Actions

ไฟล์ `.github/workflows/deploy.yml` จะ deploy ให้อัตโนมัติทุกครั้งที่ push ขึ้น `main`
ตั้งค่า **Secrets** ใน GitHub (Settings → Secrets and variables → Actions):

| Secret | ค่า |
|---|---|
| `EC2_HOST` | Public DNS / IP ของ instance |
| `EC2_USER` | เช่น `ubuntu` |
| `EC2_SSH_KEY` | private key ที่ตรงกับ authorized_keys บนเครื่อง (แนะนำสร้าง deploy key แยก) |
| `EC2_PORT` | (ไม่บังคับ) พอร์ต SSH ถ้าไม่ใช่ 22 |

---

## 5) หน้าความคืบหน้าการเรียน (`/progress/`) — ข้อมูลจาก LMS API

หน้า `/progress/` แสดงสถิติการเรียนคอร์ส Code Monkey และ **รายชื่อผู้เรียนพร้อม % ความคืบหน้า** (ค้นหา/กรอง/เรียง/ส่งออก CSV) จาก **LMS Course Status API**
(ผู้เรียนทั้งหมด / เรียนจบ / ความคืบหน้าเฉลี่ย / ไม่ได้เข้าเรียนเกิน 30 วัน / กราฟรายเดือน)

API ต้องใช้ API key จึง **ไม่เรียกจากเบราว์เซอร์** แต่ให้เซิร์ฟเวอร์ดึงแทน:

- `deploy/sync-progress.py` เรียก API ทุก 15 นาที (systemd timer) เก็บเฉพาะ
  `[เวลาเข้าเรียนล่าสุด, % ความคืบหน้า, ชื่อ-นามสกุล]` แล้วเขียนไฟล์ `/var/lib/codemonkey/progress.json`
- ⚠ รายชื่อผู้เรียน (รวมนักเรียนที่เป็นเด็ก) **เปิดให้ทุกคนที่มีลิงก์เห็นได้** — เป็นการตัดสินใจโดยเจ้าของโครงการ
- nginx เสิร์ฟไฟล์นั้นที่ `/progress/data/progress.json` (อยู่นอก web root จึงไม่โดน rsync ลบตอน deploy)
- API key เก็บที่ `/etc/codemonkey/api.env` (root เท่านั้น, 600) — **ห้าม commit คีย์ลง git**

ติดตั้งบน EC2 (ครั้งเดียว หลัง `setup-server.sh`):

```bash
sed "s/DOMAIN_PLACEHOLDER/dashboard.example.com/g" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/codemonkey >/dev/null
sudo nginx -t && sudo systemctl reload nginx
sudo bash deploy/install-progress-sync.sh     # จะถามหา API key
```

ตรวจสอบ: `systemctl list-timers codemonkey-progress.timer` และ `journalctl -u codemonkey-progress -n 20`

**ซ่อนรายชื่อ:** ใส่ชื่อ-นามสกุล (ตามที่แสดงบนหน้าเว็บ) บรรทัดละ 1 ชื่อ ในไฟล์ `/etc/codemonkey/hidden-names.txt`
รายชื่อเหล่านี้จะถูกตัดออกตั้งแต่ฝั่งเซิร์ฟเวอร์ (ไม่ถูกส่งถึงเบราว์เซอร์) มีผลในรอบ sync ถัดไป
ชื่อที่ไม่พบใน LMS จะแจ้งเตือนใน `journalctl -u codemonkey-progress`

> รันในเครื่อง: ถ้าไม่มี `progress/data/progress.json` หน้าเว็บจะใช้ `progress/data/sample.json` (ข้อมูลสมมติ) พร้อมแจ้งเตือน

---

## สรุปมาตรการความปลอดภัย ("hard to hack")

- **ไม่มี backend / ฐานข้อมูล** — static ล้วน ลดพื้นผิวโจมตีเหลือน้อยสุด
- **API key อยู่บนเซิร์ฟเวอร์เท่านั้น** — เบราว์เซอร์ได้รับเพียงไฟล์สรุป ไม่ได้เรียก LMS โดยตรง
- **HTTPS บังคับ** + **HSTS preload** + TLS 1.2/1.3 เท่านั้น
- **Content-Security-Policy** เข้มงวด: สคริปต์ทั้งหมด self-host, ห้าม inline script, จำกัดปลายทาง fetch
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP
- **UFW firewall** เปิดเฉพาะ 22/80/443 · **fail2ban** กัน brute-force SSH
- **SSH**: key-only, ปิด root login, จำกัดจำนวนครั้ง
- **Auto security updates** เปิดใช้งาน
- ไลบรารี **self-host** (ไม่พึ่ง CDN ตอนรัน) ลดความเสี่ยง supply-chain
- `.gitignore` กันการเผลอ commit คีย์/ความลับ

### ควรทำเพิ่ม (ระดับสูงขึ้น)
- จำกัด SSH (22) เฉพาะ IP ของคุณใน Security Group
- ตั้ง CloudFront / AWS WAF หน้าเว็บ ถ้าต้องการกัน DDoS และ rate-limit
- เปิด CloudWatch/Alarm ติดตามการใช้งานผิดปกติ

# แดชบอร์ดการขออนุมัติสิทธิ์ โปรแกรม Code Monkey

Dashboard สรุปคำขอรับการจัดสรรสิทธิ์โปรแกรม Code Monkey จากสถานศึกษา
อ่านข้อมูล **สด (live)** จาก Google Sheets แสดงตารางและกราฟสรุป

- คอลัมน์เรียงใหม่ตามที่กำหนด: **ชื่อสถานศึกษา → จังหวัด → อำเภอ/เขต → ตำบล/แขวง** ขึ้นก่อน
- คอลัมน์ Q3 เปลี่ยนชื่อหัวข้อเป็น **"จำนวนที่ขออนุมัติสิทธิ"**
- คอลัมน์ท้ายสุด **"สถานะการอนุมัติ"** = **"อยู่ระหว่างพิจารณา"** ทุกแถว
- แสดง **เฉพาะคอลัมน์ที่ไม่ใช่ข้อมูลส่วนบุคคล** (ไม่รวมชื่อ-นามสกุล / เบอร์โทร / อีเมล)

เป็นเว็บ static ล้วน (HTML/CSS/JS) — ไม่มี backend, ไม่มีฐานข้อมูล จึงมีพื้นผิวการโจมตี (attack surface) น้อยที่สุด

---

## โครงสร้างไฟล์

```
Dashboard Codemonkey/
├─ index.html                 หน้าเว็บหลัก
├─ assets/
│  ├─ css/styles.css
│  ├─ js/config.js            ⬅ ใส่ลิงก์ CSV ที่นี่
│  ├─ js/app.js               โหลด/แปลง/แสดงผลข้อมูล
│  └─ data/sample.csv         ข้อมูลตัวอย่าง (fallback)
├─ vendor/                    ไลบรารีที่ self-host (Chart.js, PapaParse)
├─ deploy/                    สคริปต์ติดตั้ง + ตั้งค่าความปลอดภัยบน EC2
│  ├─ nginx.conf
│  ├─ setup-server.sh
│  ├─ harden.sh
│  └─ deploy.sh
├─ .github/workflows/deploy.yml   auto-deploy ขึ้น EC2 เมื่อ push
└─ .gitignore
```

---

## 1) เชื่อมข้อมูลสดจาก Google Sheets (เผยแพร่เฉพาะคอลัมน์ที่ปลอดภัย)

ชีตต้นทางเป็นแบบส่วนตัวและมีข้อมูลส่วนบุคคล เราจึงสร้าง **แท็บใหม่ที่ดึงเฉพาะคอลัมน์ที่ไม่ใช่ PII** แล้วเผยแพร่เฉพาะแท็บนั้น ข้อมูลชื่อ/เบอร์/อีเมล จะไม่ถูกเปิดเผย

1. เปิด Google Sheet → กด **＋** (เพิ่มชีต) ที่มุมล่างซ้าย ตั้งชื่อแท็บว่า `Dashboard`
2. คลิกเซลล์ **A1** วางสูตรนี้แล้วกด Enter:

   ```
   =QUERY('การตอบแบบฟอร์ม 1'!A2:P,"select H,I,J,K,G,F,E,P,L,M,N,O where H is not null",0)
   ```

   สูตรนี้ดึงเฉพาะ 12 คอลัมน์ที่ต้องใช้ (ไม่รวมชื่อ/เบอร์/อีเมล) เรียงตามลำดับที่ต้องการ
3. เมนู **ไฟล์ → แชร์ → เผยแพร่ไปยังเว็บ** (File → Share → Publish to web)
   - ช่องซ้าย เลือกแท็บ **Dashboard** (อย่าเลือก "ทั้งเอกสาร")
   - ช่องขวา เลือก **ค่าที่คั่นด้วยจุลภาค (.csv)**
   - กด **เผยแพร่** → ยืนยัน
4. คัดลอกลิงก์ที่ได้ (หน้าตาแบบ `https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=...&single=true&output=csv`)
5. เปิด `assets/js/config.js` แล้วแทนที่ค่า `DATA_CSV_URL`:

   ```js
   DATA_CSV_URL: "วางลิงก์ CSV ที่นี่",
   ```

เปิด `index.html` แล้วข้อมูลสดจะแสดงขึ้นมา ปุ่ม **↻ รีเฟรช** จะดึงข้อมูลล่าสุดทุกครั้ง

> ถ้ายังไม่ตั้งค่า ลิงก์ แดชบอร์ดจะใช้ `assets/data/sample.csv` เป็นข้อมูลตัวอย่างชั่วคราว

---

## 2) รันในเครื่อง (local)

เป็นเว็บ static เปิดด้วยเซิร์ฟเวอร์ไฟล์ธรรมดา:

```bash
# ใน VS Code: ใช้ส่วนขยาย "Live Server" กด Go Live
# หรือใช้ Python:
python3 -m http.server 8080
# เปิด http://localhost:8080
```

---

## 3) ขึ้น Git / GitHub

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

## 4) Deploy ขึ้น EC2 (พร้อม hardening ความปลอดภัย)

### 4.1 เตรียม EC2
- สร้าง instance **Ubuntu 22.04/24.04** (t3.micro พอ)
- **Security Group** เปิดเฉพาะ: `22 (SSH)`, `80 (HTTP)`, `443 (HTTPS)` — ปิดพอร์ตอื่นทั้งหมด
  - แนะนำให้จำกัด SSH (22) ให้เฉพาะ IP ของคุณ (`My IP`)
- ใช้ **key pair** สำหรับ SSH (ไม่ใช้รหัสผ่าน)
- (แนะนำ) ชี้ **โดเมน** มาที่ Public IP ของ instance เพื่อออกใบรับรอง HTTPS

### 4.2 ติดตั้ง
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

### 4.3 อัปเดตครั้งถัดไป
```bash
cd codemonkey-dashboard && git pull && bash deploy/deploy.sh
```
หรือปล่อยให้ **GitHub Actions** deploy อัตโนมัติเมื่อ push (ดูข้อ 5)

---

## 5) Auto-deploy ด้วย GitHub Actions

ไฟล์ `.github/workflows/deploy.yml` จะ deploy ให้อัตโนมัติทุกครั้งที่ push ขึ้น `main`
ตั้งค่า **Secrets** ใน GitHub (Settings → Secrets and variables → Actions):

| Secret | ค่า |
|---|---|
| `EC2_HOST` | Public DNS / IP ของ instance |
| `EC2_USER` | เช่น `ubuntu` |
| `EC2_SSH_KEY` | private key ที่ตรงกับ authorized_keys บนเครื่อง (แนะนำสร้าง deploy key แยก) |
| `EC2_PORT` | (ไม่บังคับ) พอร์ต SSH ถ้าไม่ใช่ 22 |

---

## สรุปมาตรการความปลอดภัย ("hard to hack")

- **ไม่มี backend / ฐานข้อมูล** — static ล้วน ลดพื้นผิวโจมตีเหลือน้อยสุด
- **ไม่เปิดเผย PII** — เผยแพร่เฉพาะคอลัมน์ที่ไม่ใช่ข้อมูลส่วนบุคคล
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

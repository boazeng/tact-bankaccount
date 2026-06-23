# Deployment to Mac mini

> תואם ל-[runbook המאסטר](../../env/MAC-MINI-APP-INSTALL.md) — OrbStack + Cloudflare Tunnel + auto-deploy webhook.

| | |
|---|---|
| **App folder** | `~/server/tact-bankaccount` |
| **Container** | `tact-bankaccount` |
| **Local port** | `8098` (קונטיינר חושף 3030 פנימי) |
| **Subdomain** | `tact-bankaccount.newavera.co.il` (או מה שתבחר) |
| **State volume** | `~/server/tact-bankaccount/data` (SQLite — `tact.db`, `auth.db`) |
| **Secrets** | `~/server/tact-bankaccount/.env` (chmod 600) |

---

## 1. ריצה ראשונה ב-Mac mini

```bash
cd ~/server
git clone https://github.com/boazeng/tact-bankaccount.git
cd tact-bankaccount

# --- .env: כל הסודות (לא ב-git) ---
cat > .env <<'EOF'
# Google OAuth (אותו client של accounting/bookkeeping)
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...

# Session (שני ערכים חדשים לפרודקשן — אל תשתף עם dev!)
AUTH_SESSION_SECRET=<32+ random chars>
AUTH_EMERGENCY_TOKEN=<random token>
AUTH_SUPER_ADMIN_EMAIL=boazen@gmail.com

# Priority ERP (אותם ערכים כמו ב-bank-discrepancies)
PRIORITY_URL_REAL=...
PRIORITY_USERNAME=...
PRIORITY_PASSWORD=...

# Bank credentials vault (master key — אסור לשנות אחרי שיש סיסמאות ב-DB!)
# יצירה: openssl rand -hex 32
BANK_VAULT_KEY=...

# Bank credentials — אופציונלי, רק להזרקה ראשונית. אחרי שהן ב-DB אפשר למחוק.
# (אם לא ב-.env, צריך להגדיר ידנית דרך /bank-credentials.html אחרי deploy)
LEUMI_USERNAME=...
LEUMI_PASSWORD=...
LEUMI_URL=...

DISCOUNT_USER_ID=...
DISCOUNT_PASSWORD=...
DISCOUNT_URL='https://start.telebank.co.il/login/#/LOGIN_PAGE_SME'

POALIM_USER_ID=...
POALIM_PASSWORD=...
POALIM_URL=https://biz2.bankhapoalim.co.il/ng-portals/auth/he/biz-login/authenticate

MIZRACHI_USER_ID=...
MIZRACHI_PASSWORD=...
MIZRACHI_URL=https://www.mizrahi-tefahot.co.il/

# Runtime
PORT=3030
AUTH_REDIRECT_URI=https://tact-bankaccount.newavera.co.il/auth/callback
AUTH_DB_PATH=/app/data/auth.db

# Flow integration — push bank balances after every sync
FLOW_API_URL=https://flow.newavera.co.il
FLOW_API_KEY=<same value as FLOW_PUSH_API_KEY in flow's .env>
EOF
chmod 600 .env

# --- אחרי הרצה ראשונה: bootstrap יעתיק LEUMI_*/DISCOUNT_*/POALIM_*/MIZRACHI_* ל-DB מוצפנים ---
# אפשר אחר כך למחוק אותם מה-.env (BANK_VAULT_KEY חייב להישאר).

# --- state (אופציונלי, מעביר היסטוריה מ-Windows) ---
# מהמכונה המקומית:
# scp C:\Users\User\Aiprojects\tact-bankaccount\data\tact.db boazenglander@mac-mini:~/server/tact-bankaccount/data/
# scp C:\Users\User\Aiprojects\env\auth.db boazenglander@mac-mini:~/server/tact-bankaccount/data/

# --- בנייה + הרצה ---
~/.orbstack/bin/docker compose up -d --build

# --- בדיקה לוקאלית ---
curl -s -o /dev/null -w "local=%{http_code}\n" http://127.0.0.1:8098/login
# צריך 200 (דף הלוגין)
```

---

## 2. חיבור Cloudflare Tunnel

**א.** ערוך `~/.cloudflared/config.yml` והוסף **לפני** ה-catch-all 404:
```yaml
  - hostname: tact-bankaccount.newavera.co.il
    service: http://localhost:8098
```
ולדציה: `/opt/homebrew/bin/cloudflared tunnel ingress validate`

**ב.** ב-Cloudflare dashboard → DNS → Add record:
- Type: `CNAME`
- Name: `tact-bankaccount`
- Target: `ae8d8404-c382-475e-a31d-ad5ee34387e1.cfargotunnel.com`
- Proxy: 🟠 Proxied

**ג.** הפעל מחדש את ה-tunnel (sudo נדרש — הרץ על ה-Mac עצמו):
```bash
sudo launchctl stop com.cloudflare.cloudflared && sudo launchctl start com.cloudflare.cloudflared
```

**ד.** הוסף את ה-redirect URI ל-Google OAuth client בקונסול:
```
https://tact-bankaccount.newavera.co.il/auth/callback
```

---

## 3. אימות

```bash
# מה-Mac או מכל מקום:
curl -sI https://tact-bankaccount.newavera.co.il/login   # 200

# לוגים חיים מהקונטיינר:
~/.orbstack/bin/docker logs tact-bankaccount -f
```

פתח בדפדפן: `https://tact-bankaccount.newavera.co.il` → Google OAuth → אמור להיכנס.

---

## 4. אוטו-deploy (git push → פרודקשן) ⭐

הוסף מיפוי ב-`~/server/deployer/deploy.sh`:
```bash
case "$REPO" in
  ...
  tact-bankaccount) APP_DIR=~/server/tact-bankaccount ;;
  ...
esac
```

ב-GitHub: repo → Settings → Webhooks → Add webhook:
- Payload URL: `https://deploy.newavera.co.il`
- Content type: `application/json`
- Just the push event

מעכשיו `git push origin main` → פרוס תוך ~30 שניות. לוג: `tail ~/server/deployer/deploy.log`.

⚠️ **בנייה ראשונה לוקחת ~3-5 דקות** (הורדת Chromium + dependencies). פושים עוקבים מהירים יותר אם המודולים לא השתנו.

---

## 5. עדכון רישומי הפורט

עדכן ב-`~/server/readme_load_server.md` ובmrשרשם הפורטים של [המאסטר](../../env/MAC-MINI-APP-INSTALL.md):
```
| 8098 | tact-bankaccount | tact-bankaccount.newavera.co.il |
| 8099+ | פנוי לפרויקט הבא |
```

---

## 6. תחזוקה

### Backup
ה-state ב-`~/server/tact-bankaccount/data/` (תיקיית volume). הוסף ל-backup הקיים שלך אם יש.

### שדרוג סקרייפר
ב-dev: עדכן + push. אם autodeploy פעיל → אוטומטית. אחרת ידנית על המק:
```bash
cd ~/server/tact-bankaccount
git pull
~/.orbstack/bin/docker compose up -d --build --force-recreate
```

### צריך לרענן את ה-Chromium?
המק M4 הוא arm64. ה-Dockerfile משתמש ב-Debian's Chromium (לא ב-Puppeteer's bundled). שדרוג נעשה אוטומטית ב-`docker compose up --build` כשמתעדכן ה-base image.

---

## גוטצ'ות צפויים

1. **shm_size: '1gb'** — חובה ב-docker-compose, אחרת Chromium קורס בעמודי בנקים כבדים (default Docker = 64MB).
2. **SMS 2FA של הפועלים** — עדיין דורש שמשתמש יזין קוד דרך ה-UI שלנו. לא יעבוד עם cron אוטומטי בלי שינוי. בסנכרון ראשון מהמק → המשתמש מתחבר ל-`https://tact-bankaccount.newavera.co.il`, לוחץ סנכרון, מקבל SMS, מזין במודאל.
3. **auth.db ראשוני** — אם לא העתקת מהמכונה, רק ה-super-admin (boazen@gmail.com) נכנס. הוא יוסיף משתמשים אחרים ב-`/users.html`.
4. **Time zone** — `TZ=Asia/Jerusalem` ב-Dockerfile. ודא ש-fmtDate ב-UI מציג תאריכים נכונים.

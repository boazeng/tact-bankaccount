# Deployment to Mac mini

מדריך התקנה והרצה של TACT BankAccount על מק מיני כשרת ביתי, כולל HTTPS דרך
תת-דומיין משלך.

> כל מקום שבו רשום `<SUBDOMAIN>` — החלף בתת-הדומיין האמיתי (למשל `bank.newavera.co.il`).
> `<MAC_USER>` — המשתמש שלך על המק מיני (למשל `boaz`).

---

## 1. דרישות מקדימות על המק מיני

```bash
# Node 22 (matches dev box)
brew install node@22
node --version  # should print v22.x

# Git + Caddy (for auto-HTTPS reverse proxy) + Chromium for Puppeteer
brew install git caddy
brew install --cask google-chrome

# Optional but recommended: pm2 for process management
npm install -g pm2
```

---

## 2. קלון את הריפו

```bash
cd ~
git clone https://github.com/boazeng/tact-bankaccount.git
cd tact-bankaccount
npm install
npx puppeteer browsers install chrome
```

---

## 3. סודות — שני קבצים נפרדים

האפליקציה צריכה גישה לשני סטים של credentials. **שניהם נשמרים מחוץ לתיקיית הריפו**.

### `~/tact-secrets/.env`
```bash
mkdir -p ~/tact-secrets
chmod 700 ~/tact-secrets
```

צור את הקובץ עם:
```ini
# === Google OAuth (same client as accounting/bookkeeping) ===
GOOGLE_OAUTH_CLIENT_ID=<מהקובץ המקומי>
GOOGLE_OAUTH_CLIENT_SECRET=<מהקובץ המקומי>

# === Session signing ===
AUTH_SESSION_SECRET=<32+ תווים אקראיים — צור חדש לפרודקשן>
AUTH_EMERGENCY_TOKEN=<טוקן חירום — צור חדש לפרודקשן>
AUTH_SUPER_ADMIN_EMAIL=boazen@gmail.com
# AUTH_DISABLED=false  # אל תפעיל בפרודקשן

# === Priority ERP (for Priority match feature) ===
PRIORITY_URL_REAL=<מהקובץ המקומי>
PRIORITY_USERNAME=<מהקובץ המקומי>
PRIORITY_PASSWORD=<מהקובץ המקומי>

# === Runtime ===
PORT=3030
AUTH_REDIRECT_URI=https://<SUBDOMAIN>/auth/callback
AUTH_DB_PATH=/Users/<MAC_USER>/tact-secrets/auth.db
```

```bash
chmod 600 ~/tact-secrets/.env
```

### `~/tact-secrets/bank.env`
**העתק מהמכונה המקומית** (לא דרך גיט!):
```powershell
# מהמכונה (Windows)
scp "C:\Users\User\Aiprojects\env\bank.env" <MAC_USER>@<mac-mini-ip>:~/tact-secrets/bank.env
```
```bash
# על המק מיני
chmod 600 ~/tact-secrets/bank.env
```

### עדכון מסלולים בקוד אם צריך
האפליקציה כיום קוראת מ-`C:/Users/User/Aiprojects/env/.env` ו-`bank.env`.
על המק נצטרך להגדיר משתני סביבה שיצביעו על המסלולים החדשים, או לשנות את
טעינת dotenv בקוד. השלב הזה ייעשה בזמן הדפלוי הראשון.

---

## 4. עדכון Google OAuth — הוסף את ה-redirect URI החדש

בקונסול Google → APIs & Services → Credentials → Bookkeeping Web OAuth client:

**Authorized redirect URIs** — הוסף:
```
https://<SUBDOMAIN>/auth/callback
```

(הקיים `http://localhost:3030/auth/callback` יכול להישאר לפיתוח).

---

## 5. Caddy reverse proxy עם HTTPS אוטומטי

צור `~/Caddyfile`:
```caddy
<SUBDOMAIN> {
    reverse_proxy localhost:3030
    encode gzip
}
```

הפעל את Caddy כשירות:
```bash
brew services start caddy
# Caddy יבקש Let's Encrypt cert אוטומטית
```

> דורש שה-DNS של `<SUBDOMAIN>` מצביע ל-IP של המק מיני (A record),
> ושהפורטים 80+443 פתוחים בראוטר/חומת אש.

---

## 6. הרץ את האפליקציה (PM2)

```bash
cd ~/tact-bankaccount
pm2 start "npm start" --name tact-bankaccount --update-env
pm2 save
pm2 startup  # הריצת השרת אוטומטית אחרי reboot
```

בדיקות:
```bash
pm2 logs tact-bankaccount         # לראות לוגים חיים
curl https://<SUBDOMAIN>/login    # אמור להחזיר את דף הלוגין
```

---

## 7. מה לעשות עם הקבצים שעוברים בדפלוי הראשון

לאחר שהאפליקציה רצה ועובדת:
1. **לוקאלית** — אם רוצים — להעביר את `data/tact.db` מהמכונה המקומית למק (העתקה ידנית, לא דרך git). זה ישמר את ההיסטוריה.
2. **או** — להריץ סנכרון נקי על המק (יוריד שוב מהבנקים את כל ה-30 הימים האחרונים).

---

## 8. אבטחה — לפני שעולים live

✅ HTTPS דרך Caddy (Let's Encrypt)
✅ `.env` ב-`~/tact-secrets/` עם chmod 600
✅ `AUTH_SESSION_SECRET` חדש לפרודקשן
✅ `AUTH_EMERGENCY_TOKEN` חדש לפרודקשן (כל מי שיודע אותו עוקף Google!)
✅ אל תפתח את פורט 3030 ישירות באינטרנט — רק 443 דרך Caddy
✅ **הגבל גישה ל-`/users.html`** — רק admin רואה אותו (כבר במידלוור)
✅ Tailscale אם רוצים לוודא שרק LAN/VPN רואים את השרת לפני HTTPS

⚠️ הסקרייפר משתמש ב-Puppeteer headless שמתחבר לאתרי הבנקים עם הסיסמאות.
אם השרת נפרץ, התוקף יכול לקבל את הסיסמאות מהזיכרון של התהליך. לכן:
- חיוני שהמק מיני יהיה מאחורי חומת אש
- חיוני שיהיו עדכוני macOS/brew סדירים

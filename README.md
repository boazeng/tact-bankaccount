# TACT BankAccount

דשבורד לניהול חשבונות בנק של קבוצת TACT — מוריד תנועות מבנקים, שומר ב-SQLite, ומציג ב-UI בעיצוב TACT.

## הרצה
```powershell
npm install              # ראשון בלבד
npm start                # שרת על http://localhost:3030
```
פותחים את הדפדפן ב-http://localhost:3030 ולוחצים "סנכרון 30 ימים" ליד הבנק.

## CLI scraper (ללא UI)
```powershell
npm run scrape           # 30 ימים אחרונים
npm run scrape:90        # 90 ימים
node src/scrape.js 7     # מספר ימים מותאם
```
שומר גם ב-DB וגם בקבצי JSON/CSV ב-`output/`.

## מבנה
```
src/
  server.js           # Express + SSE
  db.js               # SQLite (better-sqlite3) — schema, queries, dedup
  scrape.js           # CLI wrapper
  scrapers/
    index.js          # Bank registry
    leumi.js          # Leumi business scraper
public/
  index.html          # רשימת בנקים+חשבונות
  account.html        # תנועות חשבון יחיד
  style.css           # design tokens מ-TACT (שחור+אדום)
  app.js              # frontend logic
data/
  tact.db             # SQLite (auto-created, gitignored)
```

## DB schema
- `banks` — רשם בנקים נתמכים
- `accounts` — חשבונות שהתגלו (UNIQUE על `bank_id + masked_number`)
- `transactions` — תנועות (UNIQUE על `account_id + bank_transaction_id` → dedup אוטומטי)

`INSERT OR IGNORE` על constraint התנועות מבטיח שסנכרון חוזר לא יוצר כפילויות. הקוד מדווח כמה תנועות חדשות נשמרו ועל כמה דולגו.

## הוספת בנק חדש
1. צור `src/scrapers/<bank>.js` שמייצא `scrape({credentials, daysBack, onProgress})` ו-`bankInfo`
2. רשום ב-`src/scrapers/index.js` תחת `bankRegistry`
3. הוסף ל-`bank.env`: `<BANK>_USERNAME`, `<BANK>_PASSWORD`, `<BANK>_URL`

ה-UI מתגלה אוטומטית את כל הבנקים מהרשם.

## API
- `GET /api/banks` — בנקים + חשבונות + מטא
- `POST /api/banks/:bankId/sync?days=N` — SSE stream של progress (events: `progress`, `account-saved`, `done`, `error`)
- `GET /api/accounts/:id/transactions?limit=&offset=` — תנועות לחשבון

## תצורה
- פורט: `PORT=3030` (ברירת מחדל), משתנה סביבה
- credentials: `C:\Users\User\Aiprojects\env\bank.env` (Leumi משתמש ב-`USER_NAME`/`USER_PASSWARD`/`URL` כברירת מחדל)

# דוח פורמטי נתונים מהבנקים

מסמך זה מתאר את הנתונים שמגיעים מכל בנק (לאומי, דיסקונט, הפועלים, מזרחי-טפחות),
איך הם נראים בתגובה הגולמית, ואיך הם ממופים לסכמת ה-DB המנורמלת שלנו.

מבוסס על הקוד ב-[src/scrapers/](../src/scrapers/) ועל הסכמה ב-[src/db.js](../src/db.js).

---

## 1. הסכמה המנורמלת (מה נשמר ב-DB)

### טבלת `accounts`
| עמודה | תיאור |
|---|---|
| `id` | מזהה פנימי (autoincrement) |
| `bank_id` | `leumi` / `discount` / `poalim` / `mizrachi` |
| `account_index` | אינדקס פנימי של הבנק |
| `masked_number` | מספר חשבון מוצג (למשל `855-11200/06`, `157-252378948`) |
| `corporate_name` | שם בעל החשבון/חברה |
| `iban` | רק לאומי מחזיר IBAN |
| `last_balance` | יתרה נוכחית |
| `branch_id` | מספר סניף (מספרי) |
| `branch_name` | שם סניף (רק דיסקונט מחזיר) |
| `is_active` | האם החשבון פעיל (1/0) |
| `last_sync_at` | תאריך סנכרון אחרון |

### טבלת `transactions`
| עמודה | תיאור |
|---|---|
| `bank_transaction_id` | מזהה ייחודי לdedup (`UNIQUE(account_id, bank_transaction_id)`) |
| `date` | YYYY-MM-DD |
| `effective_date` | תאריך ערך |
| `description` | תיאור התנועה |
| `extended_description` | תיאור מורחב (אופציונלי) |
| `amount` | סכום **חתום** (שלילי=חיוב, חיובי=זיכוי) |
| `running_balance` | יתרה אחרי התנועה |
| `beneficiary_name`, `beneficiary_bank_code`, `beneficiary_branch`, `beneficiary_account` | פרטי מוטב |
| `reference_number` | אסמכתא |
| `status` | `completed` / `pending` |
| `raw_json` | כל המידע הגולמי כפי שהגיע מהבנק (לשליפת שדות נוספים בעתיד) |

---

## 2. בנק לאומי (digitalfront — עסקים)

**קובץ:** [src/scrapers/leumi.js](../src/scrapers/leumi.js)

### Login flow
1. נכנסים ל-`https://www.leumi.co.il/he` (gateway `sysNum=23` לעסקים)
2. ממלאים `שם משתמש` + `סיסמה` + לוחצים "כניסה לחשבון"
3. מנווטים ל-`/staticcontent/digitalfront/he/nis-accounts/nis-transactions/?accountIndex=1` כדי לתפוס headers של ה-SPA
4. ללא SMS (לפחות במכשיר אמין)

### Endpoints
| מטרה | URL | Method |
|---|---|---|
| רשימת חשבונות | `/v1/corp/ui-corp-transactions/availableaccountsilstransactions/digitalfront/available-accounts/ils?comboMethod=true` | GET |
| תנועות בטווח | `/v1/corp/ui-corp-transactions/transactionsbydates/digitalfront/accounts/{idx}/transactions/bydates?periodType=1&fromDate=YYYYMMDD&toDate=YYYYMMDD` | GET |

### Headers נדרשים
מוטמעים אוטומטית מהזרימה — חשובים `X-Message-ID` ו-`X-Transaction-ID` (UUID חדש לכל בקשה).

### תגובת תנועה גולמית — שדות מרכזיים
```json
{
  "transactionID": "00151416120260526",
  "date": "2026-05-26T00:02:00",
  "effectiveDate": "2026-05-26T00:01:59",
  "description": "שיק",
  "extendedDescription": null,
  "amount": -50000.0,
  "runningBalance": 1032.79,
  "beneficiaryName": null,
  "beneficiaryBankCode": "00",
  "beneficiaryBranch": "000",
  "beneficiaryAccountNumber": null,
  "referenceNumber": "5000027"
}
```

### מיפוי לסכמה
| שדה גולמי | → שדה DB |
|---|---|
| `transactionID` | `bank_transaction_id` |
| `date.slice(0,10)` | `date` |
| `effectiveDate.slice(0,10)` | `effective_date` |
| `description` | `description` |
| `extendedDescription` | `extended_description` |
| `amount` (כבר חתום) | `amount` |
| `runningBalance` | `running_balance` |
| `beneficiaryName/BankCode/Branch/AccountNumber` | `beneficiary_*` |
| `referenceNumber` | `reference_number` |

### הערות
- **רשימת חשבונות** מכילה `accountIndex` (1-based), `maskedClientNumber` (`855-11200/06`), `corporateName`, `balanceIncludingToday`
- **תנועות עתידיות** (`todayILSTrxItems`) נשמרות כ-`status=pending`
- **שם סניף**: לא מוחזר. מתחלץ ממספר מהקידומת של `masked_number` (`855-...` → 855)

---

## 3. בנק דיסקונט (telebank apollo SME)

**קובץ:** [src/scrapers/discount.js](../src/scrapers/discount.js)

### Login flow
1. URL: `https://start.telebank.co.il/login/#/LOGIN_PAGE_SME` (חשוב! `LOGIN_PAGE_SME` עם הסיומת. `LOGIN_PAGE` בלי `_SME` הוא טופס פרטיים)
2. ⚠️ URL חייב להיות **בין מרכאות** ב-`.env` (`URL='...'`) — אחרת dotenv חותך את כל מה שאחרי `#`
3. ממלאים מספר זהות + סיסמה + "כניסה"
4. ללא SMS במכשיר אמין

### Endpoints
| מטרה | URL | Method |
|---|---|---|
| רשימת חשבונות + חברות | `/Titan/gatewayAPI/userAccounts/bsUserAccountsData?FetchAccountsNickName=true&FirstTimeEntry=true` | GET |
| מידע + יתרה לחשבון | `/Titan/gatewayAPI/accountDetails/infoAndBalance/{accountNumber}` | GET |
| תנועות בטווח | `/Titan/gatewayAPI/lastTransactions/transactions/{accountNumber}/ByDate?FromDate=YYYYMMDD&ToDate=YYYYMMDD&IsTransactionDetails=True&IsFutureTransactionFlag=True&IsEventNames=True&IsCategoryDescCode=True` | GET |

### Headers נדרשים (custom)
- `accountnumber: {accountNumber}` — דורש שינוי בכל קריאה
- `businessprocessid: OSH_LENTRIES_ALTAMIRA`
- `uuid: {CategoryNumber}` — מתוך תגובת `bsUserAccountsData`
- `site: sme`
- `language: HEBREW`

### תגובת תנועה גולמית — שדות מרכזיים
```json
{
  "Urn": "20260228225544380589PAC0D435",
  "OperationDate": "20260301",
  "ValueDate": "20260227",
  "OperationCode": "181",
  "OperationDescription": "עמלת רישום פעולה במט\"י",
  "OperationDescriptionToDisplay": "עמלת רישום פעולה במט\"י",
  "OperationDescription2": "",
  "OperationDescription3": "",
  "OperationAmount": -60.75,
  "BalanceAfterOperation": -54494.48,
  "OperationNumber": 379,
  "OperationBank": "11",
  "OperationBranch": "157",
  "beneficiaryName": null
}
```

### מיפוי לסכמה
| שדה גולמי | → שדה DB |
|---|---|
| `Urn` (ייחודי וקבוע) | `bank_transaction_id` |
| `OperationDate` (YYYYMMDD → ISO) | `date` |
| `ValueDate` (YYYYMMDD → ISO) | `effective_date` |
| `OperationDescriptionToDisplay \|\| OperationDescription` | `description` |
| `OperationDescription2 + 3` (join) | `extended_description` |
| `OperationAmount` (כבר חתום) | `amount` |
| `BalanceAfterOperation` | `running_balance` |
| `OperationBank` | `beneficiary_bank_code` |
| `OperationBranch` | `beneficiary_branch` |
| `OperationNumber` | `reference_number` |

### הערות
- **רשימת חברות** ב-`UserCompanies[]` (4 חברות) + **חשבונות** ב-`UserAccounts[]`. שדה `CompanyIdentityNumber` מקשר ביניהם
- **שם סניף**: דיסקונט **כן** מחזיר ב-`AccountInfoAndBalance.HandlingBranchName` (למשל "סניף התעשיה חולון") — היחיד שעושה זאת
- **כפילויות בdedup**: `IsFutureTransactionFlag=True` מחזיר תנועות עתידיות שלעיתים חוזרות בהיסטוריה. ה-dedup על Urn מטפל בזה
- פורמט תאריך: YYYYMMDD (מומר ל-ISO `YYYY-MM-DD`)

---

## 4. בנק הפועלים (biz2 hapoalim)

**קובץ:** [src/scrapers/poalim.js](../src/scrapers/poalim.js)

### Login flow
1. URL: `https://biz2.bankhapoalim.co.il/ng-portals/auth/he/biz-login/authenticate` (עסקים — לא להגיע דרך login.bankhapoalim.co.il שזה לפרטיים)
2. ממלאים `#user-code` + `#password` + "כניסה"
3. **🔐 דורש SMS 2FA** — הקוד מגיע לנייד, נכנס ב-modal של ה-UI שלנו (לא בדפדפן של הבנק)
4. פנימית: זרימה דרך `/authenticate/init` → `/authenticate/verify` → `/authenticate/logonotp/init` → `/authenticate/logonotp/verify`

### Endpoints
| מטרה | URL | Method |
|---|---|---|
| רשימת חשבונות | `/ServerServices/general/accounts?lang=he` | GET |
| תנועות בטווח | `/ServerServices/current-account/transactions?numItemsPerPage=500&sortCode=1&retrievalEndDate=YYYYMMDD&retrievalStartDate=YYYYMMDD&accountId=BANK-BRANCH-ACCOUNT&lang=he` | **POST** (body: `"[]"`) |

### Headers נדרשים
- `x-xsrf-token: ...` — חייב לקרוא מהcookie `XSRF-TOKEN` ולשלוח decoded

### פורמט accountId
`{bank}-{branch}-{account}` למשל `12-610-118686`

### תגובת תנועה גולמית — שדות מרכזיים
```json
{
  "eventDate": 20260527,
  "valueDate": 20260527,
  "activityDescription": "העברה",
  "activityDescriptionIncludeValueDate": null,
  "referenceNumber": 461357742,
  "referenceCatenatedNumber": 2,
  "eventAmount": 328000.0,
  "eventActivityTypeCode": 2,
  "currentBalance": 419.0,
  "transactionType": "TODAY",
  "beneficiaryDetailsData": {
    "partyHeadline": "...",
    "beneficiaryName": "...",
    "bankNumber": 10,
    "branchNumber": 800,
    "accountNumber": "..."
  }
}
```

### מיפוי לסכמה
| שדה גולמי | → שדה DB |
|---|---|
| `{eventDate}-{referenceNumber}-{referenceCatenatedNumber}` | `bank_transaction_id` (composite) |
| `eventDate` (YYYYMMDD → ISO) | `date` |
| `valueDate` (YYYYMMDD → ISO) | `effective_date` |
| `activityDescription` | `description` |
| `activityDescriptionIncludeValueDate` | `extended_description` |
| `eventAmount` × sign(`eventActivityTypeCode==1` ? +1 : -1) | `amount` |
| `currentBalance` | `running_balance` |
| `beneficiaryDetailsData.partyHeadline \|\| beneficiaryName` | `beneficiary_name` |
| `beneficiaryDetailsData.bankNumber` | `beneficiary_bank_code` |
| `beneficiaryDetailsData.branchNumber` | `beneficiary_branch` |
| `beneficiaryDetailsData.accountNumber` | `beneficiary_account` |
| `referenceNumber` | `reference_number` |

### הערות
- ⚠️ `eventActivityTypeCode`: **1 = זיכוי** (חיובי), כל ערך אחר = חיוב (שלילי). הסקרייפר ממיר אוטומטית
- `eventAmount` תמיד חיובי — הסימן נקבע מ-`eventActivityTypeCode`
- חלק מהתנועות מחזירות גוף ריק/204 — הסקרייפר מטפל בלי לקרוס

---

## 5. בנק מזרחי-טפחות (Sky OnlineApp)

**קובץ:** [src/scrapers/mizrachi.js](../src/scrapers/mizrachi.js)

### Login flow
1. URL מוגן: `https://mto.mizrahi-tefahot.co.il/OnlineApp/index.html` — SiteMinder מפנה אוטומטית לטופס הלוגין על `www.mizrahi-tefahot.co.il/login/`
2. ממלאים `#userNumberDesktopHeb` + `#passwordDesktopHeb` + "כניסה"
3. **🔐 לעיתים** דורש SMS 2FA (בהתחברות ראשונה ממכשיר חדש)
4. אחרי הלוגין, SPA קורא ל-`/SkyBL/logon` שמחזיר את **כל החשבונות** של המשתמש

### Endpoints
| מטרה | URL | Method |
|---|---|---|
| מידע משתמש + רשימת חשבונות | `/Online/api/SkyBL/logon` | POST (body: `{"appId":"skyWeb","appVer":"","lang":"he-il","isPdf":false}`) |
| החלפת חשבון פעיל | `/Online/api/SkyBL/changeAccount` | POST (body: `{"selectedAccountIndex":N}` — 0-indexed) |
| יתרה (לחשבון הנוכחי בsession) | `/Online/api/OSH/Get428ODS` | POST (body: `{}`) |
| תנועות בטווח | `/Online/api/SkyOSH/get428Index` | POST |

### בקשת תנועות (body)
```json
{
  "inToDate": "27/05/2026",
  "inFromDate": "28/04/2026",
  "inSugTnua": "",
  "table": {
    "sortExpression": "MC02PeulaTaaEZ DESC",
    "sortOrder": "DESC",
    "startRowIndex": 0,
    "maxRow": 500,
    "actionGuid": ""
  },
  "isFromSearch": false
}
```

⚠️ **פורמט תאריך: DD/MM/YYYY** — שונה מכל שאר הבנקים!

### תגובת תנועה גולמית — שדות מרכזיים (Hebrew abbreviations)
```json
{
  "RecType": 1,
  "RecTypeSpecified": true,
  "RowNumber": "2",
  "TransactionNumber": "1",
  "Icone": " 05",
  "MC02PeulaTaaEZ": "2026-05-05T00:00:00",  // תאריך פעולה
  "MC02PeulaTaaEZSpecified": true,
  "TaarichEreh": "2026-05-04T00:00:00",     // תאריך ערך
  "MC02TnuaTeurEZ": "החזר שיק",             // תיאור תנועה
  "MC02SchumEZ": 1500.0,                    // סכום (תמיד חיובי)
  "MC02OfiSchumEZ": 1,                      // אופי סכום (1=זיכוי)
  "MC02YitraEZ": 5000.0,                    // יתרה אחרי
  "MC02AsmEZ": "...",                       // אסמכתא
  "MC02AsmahtaMekoritEZ": "...",            // אסמכתא מקורית
  "NegdiBank": null,                        // בנק נגדי
  "NegdiSnif": null,                        // סניף נגדי
  "NegdiShem": null,                        // שם נגדי
  "NegdiCheshbon": null,                    // חשבון נגדי
  "P428G2Details": null                     // פרטים נוספים
}
```

### מיפוי לסכמה
| שדה גולמי | → שדה DB |
|---|---|
| `{maskedNumber}\|{date}\|{ref}\|{RowNumber}` | `bank_transaction_id` (composite) |
| `MC02PeulaTaaEZ.slice(0,10)` | `date` |
| `TaarichEreh.slice(0,10)` | `effective_date` |
| `MC02TnuaTeurEZ \|\| Teur` | `description` |
| `P428G2Details` | `extended_description` |
| `MC02SchumEZ` × sign(`MC02OfiSchumEZ==1` ? +1 : -1) | `amount` |
| `MC02YitraEZ` | `running_balance` |
| `NegdiShem` | `beneficiary_name` |
| `NegdiBank` | `beneficiary_bank_code` |
| `NegdiSnif` | `beneficiary_branch` |
| `NegdiCheshbon` | `beneficiary_account` |
| `MC02AsmEZ \|\| MC02AsmahtaMekoritEZ \|\| TransactionNumber` | `reference_number` |

### הערות
- ⚠️ ה-session **קשור לחשבון אחד בלבד** — חייבים לקרוא ל-`changeAccount` לפני שליפת תנועות לחשבון אחר
- **רשימת החשבונות** מגיעה ב-`body.user.Accounts[]` של תגובת ה-logon. **חייבים** להאזין לה תוך כדי הלוגין — קריאה חוזרת ל-logon לא תחזיר את הרשימה
- שורה ראשונה בתגובה היא בדרך כלל header/marker — מסונן ע"י `RecTypeSpecified && MC02PeulaTaaEZSpecified`
- **שם סניף** לא מוחזר. רק `BranchForDispaly` (מספר)
- כל אובייקט account ב-Accounts מכיל גם `SnifAndNumber400` (`461-550217`), `Name`, `Number`, `Branch`, `Details`

---

## 6. סיכום השוואתי

| יכולת | לאומי | דיסקונט | הפועלים | מזרחי |
|---|---|---|---|---|
| **רשימת חשבונות** | ✓ Endpoint נפרד | ✓ עם רשימת חברות | ✓ Endpoint נפרד | רק ב-logon response |
| **שם סניף** | ❌ (רק מספר) | ✅ "סניף התעשיה חולון" | ❌ | ❌ |
| **IBAN** | ✅ | ❌ | ❌ | ❌ |
| **שם מוטב** | ✅ | ❌ | ✅ | ✅ (אם יש) |
| **SMS 2FA** | ❌ | ❌ | ✅ תמיד | פעמים |
| **תאריך בבקשה** | YYYYMMDD | YYYYMMDD | YYYYMMDD | **DD/MM/YYYY** |
| **סכום חתום** | ✅ ישירות | ✅ ישירות | ❌ (חישוב מ-typeCode) | ❌ (חישוב מ-OfiSchumEZ) |
| **Method לתנועות** | GET | GET | POST | POST |
| **מזהה תנועה ייחודי** | `transactionID` | `Urn` ⭐ | composite | composite |
| **תמיכה ב-pending** | ✅ `todayILSTrxItems` | ❌ | חלקית (`transactionType:"TODAY"`) | ❌ |

⭐ דיסקונט עם `Urn` הוא הכי "נקי" — מזהה אחד וייחודי לכל תנועה.

## 7. אתגרים שנפתרו (gotchas)

| בעיה | פתרון |
|---|---|
| dotenv חותך `#` ב-URL לא מצוטט (Discount) | עטיפה במרכאות בודדות ב-`.env` |
| לאומי SPA דורש headers `X-Message-ID/X-Transaction-ID` עם UUID חדש | תפיסת headers מקריאה ראשונה ב-Puppeteer + הזרקת UUID טרי |
| הפועלים דורש SMS 2FA | מודאל ב-UI שלנו, server-side bridge עם syncId |
| Mizrachi logon נקרא רק פעם אחת — אחרי זה לא מחזיר accounts | האזנה ל-`page.on('response')` תוך כדי הלוגין |
| Mizrachi session = חשבון אחד | `changeAccount(i)` לפני שליפה לכל חשבון |
| חלק מהתנועות מחזירות body ריק | `r.text()` + try/catch סביב `JSON.parse`, פוסט ייטופל כ-error per-account ולא יקרוס |
| תנועות "עתידיות" כפולות (Discount) | dedup לפי `Urn` ב-`UNIQUE(account_id, bank_transaction_id)` |
| שם סניף לא קיים ברוב הבנקים | עמודת `branch_name` nullable, רק דיסקונט מאוכלסת |

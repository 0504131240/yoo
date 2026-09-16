# תשלומים משפחתיים (yoo)

אפליקציית ווב חד-עמודית (Single Page) לניהול הוצאות ותשלומים בין משפחות - אירועים משותפים, חלוקת עלויות, מעקב חובות וקופה משותפת. הנתונים נשמרים ב-Firebase Firestore.

## הרצה מקומית

האפליקציה היא קובץ `index.html` יחיד, ללא תהליך build. אפשר לפתוח אותו ישירות בדפדפן, או להריץ שרת סטטי פשוט:

```bash
npx serve .
```

## הגדרת Firebase (חובה)

1. גש ל-[Firebase Console](https://console.firebase.google.com) וצור פרויקט חדש (חינמי).
2. בתפריט הצד: **Build → Firestore Database → Create database**. אפשר להתחיל ב-production mode (החוקים יוגדרו בשלב הבא).
3. **Project settings → General → Your apps → Add app → Web** (סימן `</>`), תן לאפליקציה שם, וקבל אובייקט `firebaseConfig`.
4. פתח את `index.html` וחפש את הבלוק:
   ```js
   const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_PROJECT_ID.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```
   והחלף את הערכים בערכים שקיבלת מ-Firebase.
5. שמור, פתח את `index.html` בדפדפן - האפליקציה תתחבר ל-Firestore ותתחיל לשמור נתונים במסמך `appData/familyPayments`.

## ⚠️ הגדרת אבטחה ב-Firebase (חשוב!)

מפתח ה-API של Firebase מוגדר בקוד (`firebaseConfig` ב-`index.html`). זה תקין ומקובל עבור אפליקציות צד-לקוח - **אבל** האבטחה האמיתית של הנתונים נקבעת ע"י **Firestore Security Rules**, שמוגדרים בקונסולת Firebase ולא בקוד הזה.

כדאי לוודא בקונסולת Firebase (Firestore Database → Rules) שהחוקים אינם פתוחים לכל (`allow read, write: if true`), כדי שלא כל מי שיש לו את הקישור לאתר יוכל לקרוא או לשנות את הנתונים הפיננסיים. מומלץ להגדיר אימות משתמשים (Firebase Authentication) ולהגביל גישה למשתמשים מאומתים בלבד, לדוגמה:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /appData/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## תכונות

- **אירועים**: יצירת אירוע משותף, חלוקת עלות שווה או הזנת תשלום בנפרד לכל משפחה
- **איזון**: חישוב אוטומטי של העברות הנדרשות בין משפחות, וסימון תשלום ישיר/מהקופה
- **ארכיון**: היסטוריית אירועים שנסגרו, מסונן לפי שנה
- **חובות**: תצוגת חובות פתוחים לכל משפחה
- **קופה משותפת**: הפקדות, משיכות והיסטוריית תנועות
- **PWA**: ניתן להוסיף למסך הבית במובייל

---

# מנגל בלהבות (mangal/) - ניהול עסק מנגלים לאירועים

אפליקציה נפרדת לחלוטין תחת התיקייה [`mangal/`](mangal/), לניהול עסק שמגיש מנגלים לאירועים. משתמשת באותו פרויקט Firebase (Firestore) אך ב-collections נפרדים (`mangalBookings`, `mangalSettings`) כדי לא להתערבב עם נתוני אפליקציית התשלומים המשפחתית.

- **`mangal/index.html`** - האתר הציבורי: גלריית תמונות, תפריטים לשלוש רמות אירוע (רגיל / רגיל+ / פרימיום) וטופס הזמנת אירוע (שם, טלפון, תאריך, כמות משתתפים, רמת אירוע, מיקום, הערות). בכל שליחה נוצר מסמך חדש ב-`mangalBookings` עם `status: "pending"`.
- **`mangal/admin.html`** - לוח ניהול פרטי (לא מקושר מהניווט, רק מקישור קטן בפוטר), מוגן בסיסמה שנקבעת בכניסה הראשונה (מוצפנת ב-SHA-256, נשמרת ב-`mangalSettings/admin`). כולל:
  - **בקשות חדשות** - התראה בתוך הלוח (בָּדג', צליל, כותרת הדף, והתראת דפדפן אם אושרה) על כל בקשת הזמנה חדשה, עם אישור/דחייה.
  - **לוח אירועים** - כל האירועים המאושרים, קרובים/עבר, ולחיצה על אירוע פותחת פרטים מלאים: מיקום, כמות משתתפים, סטטוס תשלום.
  - **חובות** - כל האירועים המאושרים שטרם שולמו במלואם, עם סכום חוב כולל.

**התאמה אישית**: פתחו את `mangal/index.html` וחפשו `TODO-EDIT` בשביל שם העסק, טלפון, וואטסאפ ומייל. תמונות אמיתיות אפשר להוסיף לתיקייה `mangal/images/` ולעדכן את מערך `GALLERY` בקובץ. את התפריטים עורכים במערך `MENUS` באותו קובץ.

⚠️ **אבטחה**: בדומה לשאר האפליקציות בריפו הזה, ההגנה על `admin.html` היא סיסמת אפליקציה בלבד (ללא Firebase Authentication אמיתי). מומלץ להגדיר בקונסולת Firebase (Firestore Database → Rules) חוקים לפי הדוגמה:

```
match /mangalBookings/{id} {
  allow create: if true;                 // כל אחד יכול לשלוח בקשת הזמנה
  allow read, update, delete: if true;   // שקול להגביל בפרודקשן (למשל Firebase Auth)
}
match /mangalSettings/{id} {
  allow read, write: if true;            // שומר את הסיסמה המוצפנת של המנהל
}
```

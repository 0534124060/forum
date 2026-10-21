// =====================================================================
//  קובץ הגדרות – פורום מידע, קהילת המתמידים עכו
//  זה הקובץ היחיד שצריך לערוך בהתקנה הראשונה.
// =====================================================================

// 1) הדביקו כאן את פרטי החיבור שקיבלתם מ-Firebase
//    (Project settings ← Your apps ← SDK setup and configuration ← Config)
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCnKP26w10niZWKXdTMu9ik9qpIHJEHk7Y",
  authDomain: "hamatmidim-ako.firebaseapp.com",
  projectId: "hamatmidim-ako",
  storageBucket: "hamatmidim-ako.firebasestorage.app",
  messagingSenderId: "839745625111",
  appId: "1:839745625111:web:e84bf609b9a96212731052",
};

// 2) טקסטים ברירת מחדל של האתר.
//    אחרי ההתקנה אפשר לשנות אותם ישירות מהאתר, בעמוד "הגדרות האתר"
//    (רק המנהל רואה אותו), בלי לערוך את הקובץ הזה.
export const SITE_DEFAULTS = {
  topLine: "בס״ד",
  community: "קהילת המתמידים – עכו",
  siteTitle: "פורום מידע",
  blessing: "בשם ה׳ נעשה ונצליח",
  committeeName: "ועדת הדיור",
  welcomeText: "ברוכים הבאים לפורום המידע של הקהילה. כדי להצטרף יש להירשם, והחשבון ייפתח לאחר אישור מנהל הפורום.",
  footerText: "",
};

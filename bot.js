const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const readline = require('readline');
require('dotenv').config();

/**
 * ============================================================================
 * CONFIGURATION VALIDATION
 * ============================================================================
 */
const REQUIRED_ENV = [
    'ADMIN_NUMBERS', 'MASTER_BACKUP_SPREADSHEET_ID',
    'MAIN_DATABASE_FOLDER_ID', 'DRIVE_FOLDER_ID',
    'SCHOOL_NAME', 'BANK_NAME', 'BANK_ACC_NAME', 'BANK_ACC_NUMBER', 'BANK_BRANCH'
];

const ENV_FILE = path.join(__dirname, '.env');
const missing = REQUIRED_ENV.filter(key => !process.env[key]?.trim());
if (missing.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing configuration in .env file:');
    missing.forEach(m => console.error(`   - ${m}`));
    console.error('\nPlease check your .env file or .env.template.');
    process.exit(1);
}

/**
 * ============================================================================
 * TABLE OF CONTENTS
 * ============================================================================
 * 1. CONFIGURATION & CONSTANTS
 * 2. STATE & SESSION MANAGEMENT
 * 3. UTILITY & RESILIENCE HELPERS
 * 4. GOOGLE API OPERATIONS (Auth, Drive, Sheets)
 * 5. WHATSAPP CORE HELPERS
 * 6. BOT EVENT HANDLERS (QR, Ready, Message)
 * 7. BOT INITIALIZATION
 * ============================================================================
 */

// --- 1. CONFIGURATION & CONSTANTS ---

// Admin and Group Configuration
let ADMIN_NUMBERS = process.env.ADMIN_NUMBERS ? process.env.ADMIN_NUMBERS.split(',').map(n => {
    let id = n.replace(/["']/g, '').trim();
    if (id && !id.includes('@')) id = `${id}@c.us`;
    return id;
}).filter(id => !!id) : [];
let GROUPS = [
    { id: process.env.GROUP_ID_6, name: 'Grade 6' },
    { id: process.env.GROUP_ID_7, name: 'Grade 7' },
    { id: process.env.GROUP_ID_8, name: 'Grade 8' },
    { id: process.env.GROUP_ID_9, name: 'Grade 9' },
    { id: process.env.GROUP_ID_10, name: 'Grade 10' },
    { id: process.env.GROUP_ID_11, name: 'Grade 11' }
];

// Google Sheets & Drive IDs
const MASTER_BACKUP_SPREADSHEET_ID = process.env.MASTER_BACKUP_SPREADSHEET_ID;
const MAIN_DATABASE_FOLDER_ID = process.env.MAIN_DATABASE_FOLDER_ID;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const RANGE = 'Sheet1!A:L'; // Includes School column

// Sheet Headers
const STUDENT_HEADERS = ['Student ID', 'Name', 'School', 'Grade', 'Month', 'Phone', 'Email', 'Tutes', 'Address', 'Status', 'Receipt URL', 'Group ID'];

// System Constants
const MENU_KEYWORD = 'menu';
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 Hour inactivity
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const MESSAGE_RATE_WINDOW_MS = 15 * 1000;
const MESSAGE_RATE_MAX = 10;
const ADMIN_BROADCAST_DELAY_MS = 800;
const OUTBOUND_DELAY_MS = 250;

const LANG = {
    EN: 'en',
    SI: 'si'
};

const I18N = {
    [LANG.EN]: {
        'language.prompt': '👋 Welcome to *{{schoolName}}*! Please select your preferred language to proceed:\n\n1️⃣ - English\n2️⃣ - Sinhala\n\n↩️ _(Type *back* for the menu)_',
        'language.invalid': '❌ Invalid selection. Please reply with **1** for English or **2** for Sinhala.',
        'menu.text': 'Welcome to *{{schoolName}}*! 🎓\n\nHow can we assist you today? Please reply with the corresponding number:\n\n1️⃣ - New admission\n2️⃣ - Pay monthly fees\n3️⃣ - Send a message to Sir/Admin\n4️⃣ - Change language\n\n💡 _(Type *menu* at any time to return to this screen)_',
        'start.newAdmissionPrompt': '🤝 Let’s begin your registration. Please provide your *full name*:\n\n🔙 _(Type *back* to edit | *menu* to exit)_',
        'start.monthlyPrompt': '🆔 Please provide your *Student ID* (e.g., 310001) to proceed with the payment:\n\n🔙 _(Type *back* to edit | *menu* to exit)_',
        'start.complainPrompt': '📝 Please type your message below. It will be forwarded directly to Sir/Admin for review.',
        'start.cancelled': '👋 Session cancelled. Please type *menu* whenever you are ready to restart.',
        'start.pickMenuOption': 'Please select a valid option (1, 2, 3, or 4) from the menu.',
        'language.changed': '✅ Your language preference has been updated successfully!',
        'start.cannotBackAfterReceipt': '❌ Changes are not permitted once the payment receipt has been uploaded.',
        'name.invalid': '❌ Invalid name. Please ensure you enter your full legal name.',
        'school.askAfterName': 'Hello *{{name}}*! 😊\nPlease provide the name of your *school*:\n\n🔙 _(Type *back* to edit)_',
        'school.invalid': '❌ Please enter a valid school name to continue.',
        'email.ask': '📧 Thank you. Please provide your *email address*:\n\n🔙 _(Type *back* to edit)_',
        'email.invalid': '❌ The email address provided is invalid. Please try again.',
        'phone.ask': '📫 Please provide the *WhatsApp number* you would like us to add to the class group:\n\n🔙 _(Type *back* to edit)_',
        'phone.invalid': '❌ Invalid WhatsApp number. Please check the format and try again.',
        'grade.ask': '{{idLine}}🎓 Which *Grade* are you currently in (6-11)?\n\n🔙 _(Type *back* to edit)_',
        'month.confirmed': '✅ Successfully saved for *{{resolved}}*.',
        'grade.invalid': '❌ Invalid input. Please enter a grade between 6 and 11.',
        'month.ask': '🗓️ Which *month* are you paying for (e.g., April)?\n\n🔙 _(Type *back* to edit)_',
        'month.invalidUnrecognized': '❌ The month provided is not recognized. Please try again.',
        'tutes.ask': '✅ Confirmed for *{{resolved}}*.\nDo you require the *tutes* to be delivered to your address? (*yes* / *no*)\n\n🔙 _(Type *back* to edit)_',
        'yesNo.invalid': '❌ Please reply with either **yes** or **no**.',
        'address.ask': '🏠 Please provide your *full home address* for tute delivery:\n\n🔙 _(Type *back* to edit)_',
        'fee.prompt': '💰 *Total Fee:* LKR {{fee}}\n\n{{bankLabel}}\n\n📸 Please complete the transfer and upload a clear *photo of the bank receipt* here to confirm.\n\n🔙 _(Type *back* to edit)_',
        'receipt.needMedia': '❌ Invalid format. Please upload the receipt as an image or a PDF file.',
        'receipt.uploading': '⏳ _Uploading your receipt, please wait..._',
        'receipt.uploadFail': '⚠️ Upload failed. Please ensure you are sending a clear JPG, PNG, or PDF file.',
        'receipt.uploadError': '⚠️ An error occurred while processing your receipt. Please try again.',
        'confirm.preview': '📋 *Enrollment Details Review:*\n\n👤 **Name:** {{name}}\n🏫 **School:** {{school}}\n🆔 **Student ID:** {{idNumber}}\n🗓️ **Month:** {{month}}\n🎓 **Grade:** {{grade}}\n📦 **Tute Delivery:** {{tutes}}{{addressLine}}\n\n*Please reply with "yes" to confirm and submit, or type "menu" to cancel.*',
        'submit.sending': '🚀 Submitting your details to the admin panel. Please wait...',
        'submit.done': '✅ Done! Your details have been sent for admin approval. You will be added to the WhatsApp groups shortly.',
        'confirm.reply': 'Please reply with **yes** to confirm or **menu** to cancel.',
        'oldConfirm.prompt': '👋 Welcome back, *{{name}}*!\n\n**Current Details:**\n🎓 Grade: {{grade}}\n📱 WhatsApp: {{phone}}\n\n*Please confirm if this is correct. Reply with "yes" or "no":*\n\n🔙 _(Type *back* to edit)_',
        'oldTutes.ask': '📦 Would you like to have the *tutes* delivered this month? (*yes* / *no*)\n\n🔙 _(Type *back* to edit)_',
        'oldConfirm.reply': 'Please provide a valid response: **yes** to confirm or **back** to revise.',
        'month.invalid': '❌ Invalid month. Please type the full name of the month (e.g., April).',
        'oldId.notFound': '❌ Student ID *{{id}}* was not found. Please verify the ID and try again.',
        'oldAddress.ask': '🏠 Please provide your preferred *delivery address* for the tutes:',
        'amount.prompt': '💰 *Total Amount Due:* LKR {{fee}}\n\n{{bankLabel}}\n\n📸 Please upload a photo of your *payment receipt* here to finalize.',
        'complain.done': '✅ Your message has been successfully delivered to Sir/Admin. Thank you!',
        'backMenu.title': '🔙 **EDIT MENU**\nWhich detail would you like to update?\n\n{{options}}\n\n_Please reply with the corresponding number, or type *cancel* to exit._',
        'back.new.name': '🤝 Please enter your *full name*:',
        'back.new.school': '🏫 Please enter your *school name*:',
        'back.new.email': '📧 Please enter your *email address*:',
        'back.new.phone': '📫 Please enter your *WhatsApp number* for the group:',
        'back.new.grade': '🎓 Please specify your *Grade* (6-11):',
        'back.new.month': '🗓️ Please specify the *month* (e.g., April):',
        'back.new.tutes': '📦 Would you like to receive *tutes*? (yes/no)',
        'back.new.invalid': '❌ Invalid choice. Please reply with a number between **1** and **7**.',
        'back.old.id': '🆔 Please enter your *Student ID* (e.g., 310001):',
        'back.old.month': '🗓️ Please specify the *month* (e.g., April):',
        'back.old.tutes': '📦 Do you require *tutes* for this month? (yes/no)',
        'back.old.invalid': '❌ Invalid choice. Please reply with a number between **1** and **3**.'
    },
    [LANG.SI]: {
        'language.prompt': '👋 *{{schoolName}}* එකට සාදරයෙන් පිළිගන්නවා! ඔයා කැමති language එක select කරන්න:\n\n1️⃣ - English\n2️⃣ - Sinhala\n\n↩️ _(මුලට යන්න *back* එවන්න)_',
        'language.invalid': '❌ වැරදි selection එකක්. English වලට **1** හෝ Sinhala වලට **2** කියලා reply කරන්න.',
        'menu.text': '*{{schoolName}}* එකට සාදරයෙන් පිළිගන්නවා! 🎓\n\nඔයාට අවශ්‍ය දේ පහත options වලින් select කරන්න:\n\n1️⃣ - New admission\n2️⃣ - Monthly fees pay කරන්න\n3️⃣ - Sir/Admin ට message එකක් එවන්න\n4️⃣ - Language එක change කරන්න\n\n💡 _(ඕනෑම වෙලාවක *menu* කියලා reply කරලා මුලට එන්න පුළුවන්)_',
        'start.newAdmissionPrompt': '🤝 අපි registration වැඩ ටික පටන් ගමු. ඔයාගේ *full name* එක එවන්න:\n\n🔙 _(වෙනස් කරන්න *back* එවන්න | ඉවත් වෙන්න *menu* එවන්න)_',
        'start.monthlyPrompt': '🆔 Payment එක කරන්න ඔයාගේ *Student ID* එක එවන්න (e.g., 310001):\n\n🔙 _(වෙනස් කරන්න *back* එවන්න | මුලට යන්න *menu* එවන්න)_',
        'start.complainPrompt': '📝 ඔයාට කියන්න තියෙන දේ type කරලා එවන්න. අපි ඒක Sir/Admin ට forward කරන්නම්.',
        'start.cancelled': '👋 Session එක cancel කළා. ආයෙත් පටන් ගන්න ඕන වුණාම *menu* කියලා එවන්න.',
        'start.pickMenuOption': 'පහත options වලින් එකක් (1, 2, 3, හෝ 4) select කරන්න.',
        'language.changed': '✅ Language එක සාර්ථකව update කළා!',
        'start.cannotBackAfterReceipt': '❌ Receipt එක upload කළාට පස්සේ details වෙනස් කරන්න බැහැ.',
        'name.invalid': '❌ නම වැරදියි. ඔයාගේ full name එක එවන්න.',
        'school.askAfterName': 'Hi *{{name}}*! 😊\nඔයාගේ *school name* එක එවන්න:\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'school.invalid': '❌ කරුණාකර නිවැරදි school name එකක් එවන්න.',
        'email.ask': '📧 Thank you. ඔයාගේ *email address* එක එවන්න:\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'email.invalid': '❌ Email address එක වැරදියි. ආයෙත් try කරන්න.',
        'phone.ask': '📫 Group එකට add කරන්න ඕන *WhatsApp number* එක එවන්න:\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'phone.invalid': '❌ WhatsApp number එක වැරදියි. නිවැරදි number එකක් එවන්න.',
        'grade.ask': '{{idLine}}🎓 ඔයා ඉගෙන ගන්නේ කීවෙනි *Grade* එකේද (6-11)?\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'month.confirmed': '✅ *{{resolved}}* මාසය සඳහා confirm කළා.',
        'grade.invalid': '❌ වැරදියි. Grade එක 6 සහ 11 අතර අගයක් එවන්න.',
        'month.ask': '🗓️ ඔයා payment එක කරන්නේ මොන *month* එකටද (Eg: April)?\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'month.invalidUnrecognized': '❌ Month එක වැරදියි. නිවැරදි මාසයක් එවන්න.',
        'tutes.ask': '✅ *{{resolved}}* මාසය සඳහා register වුණා.\nඔයාට *tutes* ගෙදරටම ගෙන්න ගන්න අවශ්‍යද? (*yes* හෝ *no* කියලා reply කරන්න)\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'yesNo.invalid': '❌ කරුණාකර "yes" හෝ "no" කියලා විතරක් reply කරන්න.',
        'address.ask': '🏠 Tutes එවන්න ඕන *full home address* එක එවන්න:\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'fee.prompt': '💰 *Total Fee:* LKR {{fee}}\n\n{{bankLabel}}\n\n📸 කරුණාකර payment එක කරලා *receipt* එකේ පැහැදිලි photo එකක් මෙතනට upload කරන්න.\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'receipt.needMedia': '❌ කරුණාකර receipt එක image එකක් හෝ PDF එකක් විදිහට එවන්න.',
        'receipt.uploading': '⏳ _Receipt එක upload වෙනවා, කරුණාකර රැඳී සිටින්න..._',
        'receipt.uploadFail': '⚠️ Upload වෙන්නෙ නැහැ. කරුණාකර පැහැදිලි photo එකක් (JPG/PNG/PDF) ආයෙත් එවන්න.',
        'receipt.uploadError': '⚠️ Receipt එක process කිරීමේදී error එකක් වුණා. ආයෙත් try කරන්න.',
        'confirm.preview': '📋 *ඔයාගේ details සියල්ල මෙන්න:*\n\n👤 **Name:** {{name}}\n🏫 **School:** {{school}}\n🆔 **Student ID:** {{idNumber}}\n🗓️ **Month:** {{month}}\n🎓 **Grade:** {{grade}}\n📦 **Tutes:** {{tutes}}{{addressLine}}\n\n*සියල්ල නිවැරදි නම් "yes" කියලා reply කරන්න. ඔක්කොම cancel කරන්න "menu" එවන්න.*',
        'submit.sending': '🚀 ඔයාගේ details ටික admin ට යවනවා. කරුණාකර රැඳී සිටින්න...',
        'submit.done': '✅ ඔයාගේ details ටික සාර්ථකව admin ට ලැබුණා. Admin approve කළාට පස්සේ ඔයාව WhatsApp groups වලට add කරයි.',
        'confirm.reply': 'ඉදිරියට යන්න "**yes**" හෝ ඉවත් වෙන්න "**menu**" කියලා reply කරන්න.',
        'oldConfirm.prompt': '👋 Welcome back, *{{name}}*!\n\n🎓 Grade: {{grade}}\n📱 WhatsApp: {{phone}}\n\n*මේ ඔයාගේ details ම නේද කියලා confirm කරගන්න "yes" හෝ "no" කියලා එවන්න:* \n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'oldTutes.ask': '📦 මේ මාසේ *tutes* ටික ගෙදරටම ගෙන්න ගන්න අවශ්‍යද? (*yes* හෝ *no* කියලා reply කරන්න)\n\n🔙 _(වෙනස් කරන්න *back* එවන්න)_',
        'oldConfirm.reply': 'කරුණාකර "**yes**" හෝ "**back**" කියලා reply කරන්න.',
        'month.invalid': '❌ නිවැරදි month එකක් නෙවෙයි. කරුණාකර නිවැරදි මාසයක් එවන්න.',
        'oldId.notFound': '❌ *{{id}}* Student ID එක record වල නැහැ. කරුණාකර ID එක නිවැරදි දැයි බලන්න.',
        'oldAddress.ask': '🏠 Tutes එවන්න ඕන *delivery address* එක එවන්න:',
        'amount.prompt': '💰 *භාවිතා කළ යුතු මුදල:* LKR {{fee}}\n\n{{bankLabel}}\n\n📸 කරුණාකර ඔයාගේ *receipt* එක මෙතනට upload කරන්න.',
        'complain.done': '✅ ඔයාගේ message එක සාර්ථකව Sir/Admin ට forward කළා. ස්තූතියි!',
        'backMenu.title': '🔙 **EDIT MENU**\nඔයාට වෙනස් කරන්න ඕන මොන detail එකද?\n\n{{options}}\n\n_අදාළ number එක reply කරන්න. ඉවත් වෙන්න ඕන නම් *cancel* එවන්න._',
        'back.new.name': '🤝 ඔයාගේ *full name* එක එවන්න:',
        'back.new.school': '🏫 ඔයාගේ *school name* එක එවන්න:',
        'back.new.email': '📧 ඔයාගේ *email address* එක එවන්න:',
        'back.new.phone': '📫 Group එකට add කරන්න ඕන *WhatsApp number* එක එවන්න:',
        'back.new.grade': '🎓 ඔයාගේ *Grade* එක (6-11) එවන්න:',
        'back.new.month': '🗓️ අදාළ *month* එක (Eg: April) එවන්න:',
        'back.new.tutes': '📦 ඔයාට *tutes* අවශ්‍යද? (yes/no)',
        'back.new.invalid': '❌ වැරදි selection එකක්. කරුණාකර **1-7** අතර number එකක් reply කරන්න.',
        'back.old.id': '🆔 ඔයාගේ *Student ID* එක (e.g., 310001) එවන්න:',
        'back.old.month': '🗓️ අදාළ *month* එක (Eg: April) එවන්න:',
        'back.old.tutes': '📦 ඔයාට මේ මාසේ *tutes* අවශ්‍යද? (yes/no)',
        'back.old.invalid': '❌ වැරදි selection එකක්. කරුණාකර **1-3** අතර number එකක් reply කරන්න.'
    }
};

function t(lang, key, vars = {}) {
    const dict = I18N[lang] || I18N[LANG.EN];
    const fallback = I18N[LANG.EN] || {};
    const template = (dict && dict[key]) || fallback[key] || key;
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

function getUserLang(from) {
    const data = userData.get(from);
    const lang = data && data.lang;
    return lang === LANG.SI ? LANG.SI : LANG.EN;
}

/**
 * Formats the bank details message from environment variables.
 */
function getBankLabel() {
    return `🏦 *Bank:* ${process.env.BANK_NAME || 'N/A'}
👤 *Account Name:* ${process.env.BANK_ACC_NAME || 'N/A'}
🔢 *Account Number:* ${process.env.BANK_ACC_NUMBER || 'N/A'}
🏢 *Branch:* ${process.env.BANK_BRANCH || 'N/A'}`;
}

let SCHOOL_NAME = process.env.SCHOOL_NAME;

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file'
];
// Path Configuration
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

// Canonical month names
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// --- 2. STATE & SESSION MANAGEMENT ---

const STATES = {
    START: 'start',
    LANGUAGE: 'language',
    NAME: 'name',
    SCHOOL: 'school',
    EMAIL: 'email',
    PHONE: 'phone',
    GRADE: 'grade',
    MONTHS: 'months',
    TUTES_OPTION: 'tutes_option',
    RECEIPT: 'receipt',
    ADDRESS: 'address',
    CONFIRM: 'confirm',
    OLD_ID: 'old_id',
    OLD_CONFIRM: 'old_confirm',
    OLD_TUTES_OPTION: 'old_tutes_option',
    OLD_MONTH: 'old_month',
    COMPLAIN: 'complain',
    BACK_MENU: 'back_menu'
};

// Runtime In-memory Storage
const userData = new Map();
const userStates = new Map();
const userHistory = new Map();
const registeredStudentIds = new Map();
const pendingApprovals = new Map();
const adminStates = new Map();
const inboundRateBuckets = new Map();
const userLangPref = new Map(); // Persists language choice across session resets

// System Control State
let isShuttingDown = false;
let isSystemReady = false;
let cachedOAuthClient = null;
let sessionSaveTimer = null;
let sessionSavePending = false;

/**
 * Resets a user's session entirely.
 */
function resetUser(from) {
    userStates.delete(from);
    userData.delete(from);
    userHistory.delete(from);
    saveSessions();
}

/**
 * Persists all active user sessions to a local JSON file.
 */
function saveSessions() {
    try {
        sessionSavePending = true;
        if (sessionSaveTimer) return;
        sessionSaveTimer = setTimeout(() => {
            try {
                if (!sessionSavePending) return;
                const data = {
                    userData: Array.from(userData.entries()),
                    userStates: Array.from(userStates.entries()),
                    userHistory: Array.from(userHistory.entries()),
                    adminStates: Array.from(adminStates.entries()),
                    userLangPref: Array.from(userLangPref.entries())
                };
                fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
            } catch (error) {
                console.error('[Persistence] Error saving sessions:', error.message);
            } finally {
                sessionSavePending = false;
                sessionSaveTimer = null;
            }
        }, 1000);
        sessionSaveTimer.unref();
    } catch (error) {
        console.error('[Persistence] Error saving sessions:', error.message);
    }
}

function saveSessionsNow() {
    try {
        if (sessionSaveTimer) {
            clearTimeout(sessionSaveTimer);
            sessionSaveTimer = null;
        }
        const data = {
            userData: Array.from(userData.entries()),
            userStates: Array.from(userStates.entries()),
            userHistory: Array.from(userHistory.entries()),
            adminStates: Array.from(adminStates.entries()),
            userLangPref: Array.from(userLangPref.entries())
        };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
        sessionSavePending = false;
    } catch (error) {
        console.error('[Persistence] Error saving sessions:', error.message);
    }
}

/**
 * Loads persisted user sessions from the local JSON file.
 */
function loadSessions() {
    try {
        if (!fs.existsSync(SESSION_FILE)) return;
        const raw = fs.readFileSync(SESSION_FILE);
        const data = JSON.parse(raw);

        if (data.userData) data.userData.forEach(([k, v]) => userData.set(k, v));
        if (data.userStates) data.userStates.forEach(([k, v]) => userStates.set(k, v));
        if (data.userHistory) data.userHistory.forEach(([k, v]) => userHistory.set(k, v));
        if (data.adminStates) data.adminStates.forEach(([k, v]) => adminStates.set(k, v));
        if (data.userLangPref) data.userLangPref.forEach(([k, v]) => userLangPref.set(k, v));

        if (userStates.size > 0) {
            console.log(`[Persistence] Restored ${userStates.size} active sessions.`);
        }
    } catch (error) {
        console.warn('[Persistence] Could not load sessions:', error.message);
    }
}

/**
 * Pushes the current state into history for "back" support.
 */
function pushHistory(from, state, data) {
    if (!userHistory.has(from)) userHistory.set(from, []);
    userHistory.get(from).push({ state, data: JSON.parse(JSON.stringify(data)) });
}

/**
 * Background Session Sweeper: Clears inactive users from memory every 15 minutes.
 */
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [from, data] of userData.entries()) {
        if (data.lastSeen && (now - data.lastSeen > SESSION_TIMEOUT_MS)) {
            resetUser(from);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) console.log(`[Sweeper] Cleaned up ${cleanedCount} inactive registration sessions.`);
}, 15 * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const [from, bucket] of inboundRateBuckets.entries()) {
        if (now - bucket.windowStart > MESSAGE_RATE_WINDOW_MS * 2) inboundRateBuckets.delete(from);
    }
}, 60 * 1000).unref();


// --- 3. UTILITY & RESILIENCE HELPERS ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Updates a key in the .env file and reloads process.env.
 */
function updateEnvFile(key, value) {
    try {
        let content = fs.readFileSync(ENV_FILE, 'utf8');
        // Robust regex to find the key even with spaces or quotes
        const regex = new RegExp(`^\\s*${key}\\s*=.*`, 'm');
        const newLine = `${key}="${value.replace(/"/g, '\\"')}"`;

        if (regex.test(content)) {
            content = content.replace(regex, newLine);
        } else {
            content = content.trim() + `\n${newLine}\n`;
        }

        fs.writeFileSync(ENV_FILE, content, 'utf8');
        process.env[key] = value; // Update in memory 

        // Sync complex variables immediately
        if (key === 'ADMIN_NUMBERS') {
            ADMIN_NUMBERS = value.split(',').map(n => {
                let id = n.trim();
                if (!id.includes('@')) id = `${id}@c.us`;
                return id;
            });
        }
        if (key === 'SCHOOL_NAME') SCHOOL_NAME = value;
        if (key.startsWith('GROUP_ID_')) {
            const grade = parseInt(key.replace('GROUP_ID_', ''), 10);
            const gIdx = GROUPS.findIndex(g => g.name === `Grade ${grade}`);
            if (gIdx >= 0) GROUPS[gIdx].id = value;
        }
        return true;
    } catch (e) {
        console.error(`Failed to update .env:`, e.message);
        return false;
    }
}

/**
 * Execute an async function with simple retry logic for Google API transients.
 */
async function executeWithRetry(fn, retries = 3, interval = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            const message = (error && error.message ? error.message : '').toLowerCase();
            const isTransient = message.includes('quota') || message.includes('ratelimit') || message.includes('500') || message.includes('enotfound') || message.includes('etimedout');
            if (i === retries - 1 || !isTransient) throw error;
            console.warn(`API call failed (attempt ${i + 1}/${retries}), retrying in ${interval}ms...`, error.message);
            await delay(interval);
        }
    }
}

function isRateLimited(from) {
    const now = Date.now();
    const bucket = inboundRateBuckets.get(from);
    if (!bucket || now - bucket.windowStart > MESSAGE_RATE_WINDOW_MS) {
        inboundRateBuckets.set(from, { count: 1, windowStart: now });
        return false;
    }
    bucket.count += 1;
    return bucket.count > MESSAGE_RATE_MAX;
}

/**
 * Normalize phone number to digits only for spreadsheet consistency.
 */
function cleanPhoneNumber(phone) {
    if (!phone) return '';
    let cleaned = phone.toString().replace(/\D/g, '');

    if (cleaned.startsWith('0')) {
        cleaned = '94' + cleaned.substring(1);
    }
    else if (cleaned.length === 9 && (cleaned.startsWith('7') || cleaned.startsWith('1') || cleaned.startsWith('6'))) {
        cleaned = '94' + cleaned;
    }

    return cleaned;
}

/**
 * Compute a simple character-similarity score between two lowercase strings.
 */
function stringSimilarity(a, b) {
    if (a === b) return 1;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) matches++;
    }
    return matches / longer.length;
}

/**
 * Validates email format.
 */
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validates phone length and format.
 */
function isValidPhone(phone) {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length >= 9 && cleaned.length <= 15;
}

/**
 * Standardizes Student ID format.
 * Supports legacy NEX-XXX and new Batch IDs (YYXXXXX).
 */
function normalizeStudentId(id) {
    if (!id) return '';
    const cleaned = id.trim().toUpperCase();

    // Check for legacy NEX format
    const legacyMatch = cleaned.match(/^NEX(?:ORA)?[-\s]?0*(\d+)$/i);
    if (legacyMatch) {
        return `NEX-${String(parseInt(legacyMatch[1], 10)).padStart(3, '0')}`;
    }

    // For batch IDs (YYXXXX), strip non-digits first to handle spaces/dashes
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (digitsOnly.length >= 6 && digitsOnly.length <= 8) return digitsOnly;

    return cleaned;
}

let idGenerationQueue = Promise.resolve();

/**
 * Generates the next available Student ID based on Batch Year.
 * Batch Year = Current Year + (11 - Grade).
 * Format: YYXXXX (e.g., 310001)
 */
async function generateBatchStudentId(grade) {
    return new Promise((resolve, reject) => {
        idGenerationQueue = idGenerationQueue.then(async () => {
            try {
                const result = await executeWithRetry(async () => {
                    const sheets = await getSheetsClient();
                    const drive = await getDriveClient();

                    const currentYear = new Date().getFullYear();
                    const batchYear = currentYear + (11 - parseInt(grade, 10));
                    const batchPrefix = String(batchYear).slice(-2);

                    // 1. Locate SystemData Sheet in the Spreadsheet
                    const ss = await sheets.spreadsheets.get({ spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID });
                    let sheet = ss.data.sheets.find(s => s.properties.title === 'SystemData');

                    if (!sheet) {
                        // Create SystemData sheet if missing
                        await sheets.spreadsheets.batchUpdate({
                            spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                            resource: { requests: [{ addSheet: { properties: { title: 'SystemData' } } }] }
                        });
                        await sheets.spreadsheets.values.update({
                            spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                            range: 'SystemData!A1:B1',
                            valueInputOption: 'RAW',
                            resource: { values: [['Batch Year', 'Last Serial']] }
                        });
                    }

                    // 2. Fetch current serial
                    const res = await sheets.spreadsheets.values.get({
                        spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                        range: 'SystemData!A:B'
                    });
                    const rows = res.data.values || [];
                    let rowIndex = rows.findIndex(r => r[0] == batchYear);
                    let nextSerial = 1;

                    if (rowIndex >= 0) {
                        nextSerial = parseInt(rows[rowIndex][1], 10) + 1;
                        await sheets.spreadsheets.values.update({
                            spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                            range: `SystemData!B${rowIndex + 1}`,
                            valueInputOption: 'RAW',
                            resource: { values: [[nextSerial]] }
                        });
                    } else {
                        rowIndex = rows.length;
                        await sheets.spreadsheets.values.append({
                            spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                            range: 'SystemData!A:B',
                            valueInputOption: 'RAW',
                            resource: { values: [[batchYear, nextSerial]] }
                        });
                    }

                    return `${batchPrefix}${String(nextSerial).padStart(4, '0')}`;
                });
                resolve(result);
            } catch (error) {
                console.error('[ID Gen] CRITICAL ERROR generating batch ID:', error.message);
                reject(error);
            }
        }).catch(err => {
            // This catch prevents a failed ID generation from completely rejecting the `idGenerationQueue` promise chain itself.
            // By catching it here, the queue stays open for the NEXT user, preventing the "Poison Pill" bug.
            console.warn('[Queue Recoved] ID Generation Queue recovered from an isolated failure.');
        });
    });
}


// --- 4. GOOGLE API OPERATIONS (Auth, Drive, Sheets) ---

/**
 * Google OAuth 2.0 Client setup with auto-refresh persistence.
 */
async function getOAuthClient() {
    if (cachedOAuthClient) return cachedOAuthClient;

    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error(`CRITICAL: credentials.json missing at ${CREDENTIALS_PATH}. Please upload your Google Cloud credentials.`);
    }

    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const key = credentials.installed || credentials.web;

    if (!key) {
        throw new Error('Invalid credentials.json format. Ensure you are using OAuth 2.0 Client IDs.');
    }

    const redirectUri = (key.redirect_uris && key.redirect_uris.length > 0) ? key.redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
    const oAuth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);

    // Event listener to automatically save and persist refreshed tokens
    oAuth2Client.on('tokens', (tokens) => {
        try {
            console.log('[Google Auth] Token Refreshed. Updating token.json...');
            let existingToken = {};
            if (fs.existsSync(TOKEN_PATH)) {
                existingToken = JSON.parse(fs.readFileSync(TOKEN_PATH));
            }
            // Merge new tokens into existing to preserve refresh_token if it's not provided in the refresh event
            const updatedToken = { ...existingToken, ...tokens };
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
        } catch (err) {
            console.error('[Google Auth] Failed to save refreshed token:', err.message);
        }
    });

    if (!fs.existsSync(TOKEN_PATH)) {
        console.error(`\n❌ ERROR: token.json NOT FOUND at ${TOKEN_PATH}`);
        console.error('Production servers cannot use interactive auth.');
        console.error('Please run "node generate_token.js" on your local machine and upload the resulting token.json to the server.\n');
        throw new Error('Authentication required but token.json is missing.');
    }

    try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        oAuth2Client.setCredentials(token);

        // Check if token is potentially expired and trigger a silent refresh check
        if (token.expiry_date && Date.now() >= token.expiry_date) {
            console.log('[Google Auth] Stored token appears expired. Preparing refresh...');
        }

        cachedOAuthClient = oAuth2Client;
        return cachedOAuthClient;
    } catch (err) {
        console.error('[Google Auth] Error loading token.json:', err.message);
        throw err;
    }
}

const getSheetsClient = async () => google.sheets({ version: 'v4', auth: await getOAuthClient() });
const getDriveClient = async () => google.drive({ version: 'v3', auth: await getOAuthClient() });

/**
 * Uploads payment receipt to designated Google Drive folder.
 */
async function uploadReceiptToDrive(media, studentId, studentName) {
    try {
        if (!media || !media.data) {
            throw new Error('Invalid media data provided for upload.');
        }

        const drive = await getDriveClient();
        if (!drive) {
            throw new Error('Failed to initialize Google Drive client.');
        }

        const buffer = Buffer.from(media.data, 'base64');
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);

        let ext = '';
        if (media.mimetype.includes('pdf')) ext = '.pdf';
        else if (media.mimetype.includes('jpeg') || media.mimetype.includes('jpg')) ext = '.jpg';
        else if (media.mimetype.includes('png')) ext = '.png';
        else {
            console.warn(`[Drive] Unrecognized mimetype: ${media.mimetype}. Defaulting to .jpg`);
            ext = '.jpg';
        }

        const fileName = `Receipt_${studentId}_${studentName.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
        const fileMetadata = {
            name: fileName,
            parents: [DRIVE_FOLDER_ID]
        };

        console.log(`[Drive] Starting upload for ${fileName}...`);
        const file = await drive.files.create({
            resource: fileMetadata,
            media: { mimeType: media.mimetype, body: stream },
            fields: 'id, webViewLink'
        });

        if (!file.data || !file.data.id) {
            throw new Error('Drive API returned empty response after upload.');
        }

        console.log(`[Drive] Upload successful: ${file.data.id}`);

        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: { role: 'reader', type: 'anyone' }
        }).catch(e => console.warn('[Drive] Public permission setup failed:', e.message));

        return file.data.webViewLink;
    } catch (error) {
        console.error('[Drive] Upload Error Detail:', error.message);
        if (error.response) {
            console.error('[Drive] Status:', error.response.status, 'Body:', error.response.data);
        }
        return null;
    }
}

/**
 * Ensures a specific sheet in a spreadsheet has current headers.
 */
async function ensureSpreadsheetHeaders(sheets, spreadsheetId, sheetTitle = 'Sheet1') {
    try {
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetTitle}!A1:L1`,
        });
        const headerRow = (headerResponse.data.values || [])[0] || [];
        const needsHeaderFix = !headerRow[0]
            || headerRow[0].toString().toUpperCase().startsWith('NEX')
            || headerRow.length !== STUDENT_HEADERS.length
            || headerRow[2] !== 'School';
        if (needsHeaderFix) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetTitle}!A1:L1`,
                valueInputOption: 'RAW',
                resource: { values: [STUDENT_HEADERS] }
            });
        }
    } catch (e) {
        console.error(`Error ensuring headers for sheet ${spreadsheetId} (${sheetTitle}):`, e.message);
    }
}

/**
 * Utility to get or create a sheet (tab) in a spreadsheet.
 */
async function getOrCreateSheet(sheets, spreadsheetId, sheetTitle) {
    const ss = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = ss.data.sheets.find(s => s.properties.title === sheetTitle);
    if (!sheet) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] }
        });
        await ensureSpreadsheetHeaders(sheets, spreadsheetId, sheetTitle);
    }
    return sheetTitle;
}

/**
 * Loads registered students from Google Sheets on bot startup.
 */
async function loadStudentsFromSheets() {
    try {
        const sheets = await getSheetsClient();

        // 1. Get all sheets in the Master Backup
        const ss = await sheets.spreadsheets.get({ spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID });
        const batchSheets = ss.data.sheets
            .map(s => s.properties.title)
            .filter(t => t.startsWith('Batch ') || t === 'Sheet1');

        for (const sheetTitle of batchSheets) {
            await ensureSpreadsheetHeaders(sheets, MASTER_BACKUP_SPREADSHEET_ID, sheetTitle);

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                range: `${sheetTitle}!A:L`,
            });

            const rows = response.data.values || [];
            if (rows.length > 1) {
                const headers = rows[0].map(h => h.trim().toLowerCase());

                // Flexible index detection
                const findIndex = (search) => headers.findIndex(h => h.includes(search.toLowerCase()));

                const idIdx = findIndex('Student ID');
                const nameIdx = findIndex('Name');
                const schoolIdx = findIndex('School');
                const gradeIdx = findIndex('Grade');
                const monthIdx = findIndex('Month');
                const phoneIdx = findIndex('Phone');
                const emailIdx = findIndex('Email');
                const tutesIdx = findIndex('Tutes');
                const addrIdx = findIndex('Address');
                const statusIdx = findIndex('Status');
                const receiptIdx = findIndex('Receipt');
                const groupIdx = findIndex('Group');

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    const id = idIdx >= 0 ? row[idIdx] : row[0];
                    if (!id) continue;

                    const normalizedId = normalizeStudentId(id);
                    const studentObj = {
                        idNumber: normalizedId,
                        name: nameIdx >= 0 ? (row[nameIdx] || '') : (row[1] || ''),
                        school: schoolIdx >= 0 ? (row[schoolIdx] || '') : '',
                        grade: gradeIdx >= 0 ? parseInt(row[gradeIdx], 10) : NaN,
                        months: monthIdx >= 0 ? (row[monthIdx] || '') : '',
                        phone: phoneIdx >= 0 ? (row[phoneIdx] || '') : '',
                        email: emailIdx >= 0 ? (row[emailIdx] || '') : '',
                        wantsTutes: tutesIdx >= 0 ? row[tutesIdx] === 'Yes' : false,
                        address: addrIdx >= 0 ? (row[addrIdx] || null) : null,
                        status: statusIdx >= 0 ? (row[statusIdx] || 'Pending') : 'Pending',
                        receiptUrl: receiptIdx >= 0 ? (row[receiptIdx] || null) : null,
                        groupId: groupIdx >= 0 ? (row[groupIdx] || null) : null
                    };

                    // Handle legacy data fallback if headers didn't match perfectly
                    if (isNaN(studentObj.grade)) {
                        const hasSchool = row.length >= 12;
                        studentObj.school = hasSchool ? (row[2] || '') : '';
                        studentObj.grade = parseInt(hasSchool ? row[3] : row[2], 10);
                        studentObj.months = hasSchool ? row[4] : row[3];
                        studentObj.phone = hasSchool ? row[5] : row[4];
                        studentObj.email = hasSchool ? row[6] : row[5];
                        studentObj.wantsTutes = (hasSchool ? row[7] : row[6]) === 'Yes';
                    }

                    // Derived fields
                    studentObj.contactId = studentObj.phone ? (studentObj.phone.includes('@') ? studentObj.phone : `${studentObj.phone.replace(/\D/g, '')}@c.us`) : null;
                    studentObj.fee = studentObj.wantsTutes ? 2500 : 1500;

                    registeredStudentIds.set(normalizedId, studentObj);

                    // Sync pending approvals for admin recovery
                    if (studentObj.status === 'Pending') {
                        pendingApprovals.set(normalizedId, studentObj);
                    }
                }
            }
        }
        // Sync pending approvals for admin recovery
        if (pendingApprovals.size > 0) {
            console.log(`[Sync] Recovered ${pendingApprovals.size} pending approvals from Google Sheets.`);
        }
        console.log(`[Sync] ✅ Loaded ${registeredStudentIds.size} students from Master Backup.`);
    } catch (error) {
        console.error('[Sync] ❌ CRITICAL: Error loading from Sheets:', error.message);
        throw error; // Rethrow to enforce the Fail-Safe mechanism in the ready event
    }
}

/**
 * Unified DB Operations: Updates both Master and Monthly spreadsheets.
 */
async function upsertStudentData(studentData, forceStatus = null, oldGrade = null, oldMonth = null) {
    return await executeWithRetry(async () => {
        const sheets = await getSheetsClient();
        const drive = await getDriveClient();

        // 0. Optional Cleanup: If grade/month changed, remove from old location first
        if (oldGrade !== null || oldMonth !== null) {
            const lastGrade = oldGrade !== null ? oldGrade : studentData.grade;
            const lastMonth = oldMonth !== null ? oldMonth : studentData.months;
            if (parseInt(lastGrade) !== parseInt(studentData.grade) || lastMonth !== studentData.months) {
                await deleteStudentFromMonthlyFile(sheets, drive, lastGrade, lastMonth, studentData.idNumber);
            }
        }

        const status = forceStatus || studentData.status || 'Pending';
        const cleanedPhone = cleanPhoneNumber(studentData.phone);
        const monthLabel = buildMonthYearLabel(studentData.months);

        const rowValues = [[
            studentData.idNumber,
            studentData.name,
            studentData.school || '',
            studentData.grade,
            monthLabel,
            cleanedPhone,
            studentData.email,
            studentData.wantsTutes ? 'Yes' : 'No',
            studentData.address || '',
            status,
            studentData.receiptUrl || '',
            studentData.groupId || ''
        ]];

        // 1. Update Master (Batch-specific tab)
        const batchYear = new Date().getFullYear() + (11 - parseInt(studentData.grade, 10));
        const batchSheetName = `Batch ${batchYear}`;
        await getOrCreateSheet(sheets, MASTER_BACKUP_SPREADSHEET_ID, batchSheetName);

        const masterRes = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID, range: `${batchSheetName}!A:L` });
        const masterRows = masterRes.data.values || [];
        const mIndex = masterRows.findIndex(r => normalizeStudentId(r[0]) === studentData.idNumber);

        if (mIndex >= 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                range: `${batchSheetName}!A${mIndex + 1}:L${mIndex + 1}`,
                valueInputOption: 'RAW',
                resource: { values: rowValues }
            });
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId: MASTER_BACKUP_SPREADSHEET_ID,
                range: `${batchSheetName}!A:L`,
                valueInputOption: 'RAW',
                resource: { values: rowValues }
            });
        }

        // 2. Update Monthly
        const folderId = await getOrCreateFolder(drive, MAIN_DATABASE_FOLDER_ID, `Grade ${studentData.grade}`);
        const monthlyFileId = await getOrCreateMonthlySpreadsheet(drive, sheets, folderId, monthLabel);
        await ensureSpreadsheetHeaders(sheets, monthlyFileId);

        const monthRes = await sheets.spreadsheets.values.get({ spreadsheetId: monthlyFileId, range: 'Sheet1!A:L' });
        const monthRows = monthRes.data.values || [];
        const moIndex = monthRows.findIndex(r => normalizeStudentId(r[0]) === studentData.idNumber);

        if (moIndex >= 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: monthlyFileId,
                range: `Sheet1!A${moIndex + 1}:L${moIndex + 1}`,
                valueInputOption: 'RAW',
                resource: { values: rowValues }
            });
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId: monthlyFileId,
                range: 'Sheet1!A:L',
                valueInputOption: 'RAW',
                resource: { values: rowValues }
            });
        }

        registeredStudentIds.set(studentData.idNumber, { ...studentData, status });
        console.log(`[Database] ✅ Successfully updated ${studentData.idNumber} (Status: ${status}) in Master and Monthly sheets.`);
    });
}

/**
 * Drive Folder Utility.
 */
async function getOrCreateFolder(drive, parentFolderId, folderName) {
    const query = `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) return response.data.files[0].id;

    const folder = await drive.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
        fields: 'id'
    });
    return folder.data.id;
}

/**
 * Monthly Spreadsheet Utility.
 */
async function getOrCreateMonthlySpreadsheet(drive, sheets, gradeFolderId, monthSheetName) {
    const query = `'${gradeFolderId}' in parents and name = '${monthSheetName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) return response.data.files[0].id;

    const newFile = await drive.files.create({
        resource: { name: monthSheetName, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [gradeFolderId] },
        fields: 'id'
    });
    const newSpreadsheetId = newFile.data.id;

    await sheets.spreadsheets.values.update({
        spreadsheetId: newSpreadsheetId,
        range: 'Sheet1!A1:L1',
        valueInputOption: 'RAW',
        resource: { values: [STUDENT_HEADERS] }
    });
    return newSpreadsheetId;
}

/**
 * Deletes a student from a specific monthly spreadsheet (cleanup for grade/month changes).
 */
async function deleteStudentFromMonthlyFile(sheets, drive, grade, month, idNumber) {
    try {
        const monthLabel = buildMonthYearLabel(month);
        if (!monthLabel) return;

        const folderId = await getOrCreateFolder(drive, MAIN_DATABASE_FOLDER_ID, `Grade ${grade}`);
        const query = `'${folderId}' in parents and name = '${monthLabel}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
        const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

        if (response.data.files.length === 0) return;
        const spreadsheetId = response.data.files[0].id;

        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:A' });
        const rows = res.data.values || [];
        const rowIndex = rows.findIndex(r => normalizeStudentId(r[0]) === normalizeStudentId(idNumber));

        if (rowIndex >= 0) {
            console.log(`[Cleanup] Removing ${idNumber} from Grade ${grade} (${monthLabel}) at row ${rowIndex + 1}`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: 0,
                                dimension: 'ROWS',
                                startIndex: rowIndex,
                                endIndex: rowIndex + 1
                            }
                        }
                    }]
                }
            });
        }
    } catch (e) {
        console.warn(`[Cleanup] Failed to remove ${idNumber} from Grade ${grade}:`, e.message);
    }
}

/**
 * Saves a student complaint to the Complaints spreadsheet.
 */
async function saveComplaintToSheets(phoneNumber, complaintText) {
    return await executeWithRetry(async () => {
        const sheets = await getSheetsClient();
        const drive = await getDriveClient();

        const query = `'${MAIN_DATABASE_FOLDER_ID}' in parents and name = 'Complaints' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
        const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

        let spreadsheetId;
        if (response.data.files.length > 0) {
            spreadsheetId = response.data.files[0].id;
        } else {
            const newSheetFile = await drive.files.create({
                resource: { name: 'Complaints', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [MAIN_DATABASE_FOLDER_ID] },
                fields: 'id'
            });
            spreadsheetId = newSheetFile.data.id;
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Sheet1!A1:D1',
                valueInputOption: 'RAW',
                resource: { values: [['Timestamp', 'Phone Number', 'Complaint', 'Status']] }
            });
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A:D',
            valueInputOption: 'RAW',
            resource: { values: [[new Date().toISOString(), phoneNumber, complaintText, 'Unresolved']] }
        });
    });
}

/**
 * Resolves free-text month input to canonical "Month-YYYY" format.
 */
function resolveMonthInput(rawInput) {
    if (!rawInput || !rawInput.trim()) return null;
    const text = rawInput.trim();
    const yearMatch = text.match(/(\d{4})/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    const wordPart = text.replace(/(\d{4})/, '').replace(/[-\s]+/g, '').trim().toLowerCase();

    const numericMonth = parseInt(wordPart, 10);
    if (!isNaN(numericMonth) && numericMonth >= 1 && numericMonth <= 12) return `${MONTH_NAMES[numericMonth - 1]}-${year}`;

    for (const month of MONTH_NAMES) {
        if (month.toLowerCase().startsWith(wordPart) || wordPart.startsWith(month.toLowerCase().slice(0, 3))) return `${month}-${year}`;
    }

    let bestMonth = null;
    let bestScore = 0;
    for (const month of MONTH_NAMES) {
        const score = stringSimilarity(wordPart, month.toLowerCase());
        if (score > bestScore) { bestScore = score; bestMonth = month; }
    }

    return bestScore >= 0.6 ? `${bestMonth}-${year}` : null;
}

const buildMonthYearLabel = (monthInput) => resolveMonthInput(monthInput);


// --- 5. WHATSAPP CORE HELPERS ---

/**
 * Sends one message or media to all configured admins.
 */
async function notifyAdmins(content, options = {}) {
    for (const admin of ADMIN_NUMBERS) {
        try {
            if (content.data && content.mimetype) {
                await client.sendMessage(admin, content);
            } else {
                await sendWA(admin, content, options);
            }
        } catch (e) {
            console.error(`Admin Notification Failed for ${admin}:`, e.message);
        }
    }
}

/**
 * Wrapper for sending WhatsApp messages with LID-to-JID resolution.
 */
async function sendWA(to, text, options = {}) {
    try {
        if (isShuttingDown) return;
        let recipient = typeof to === 'object' ? (to.from || to.id?._serialized) : to;
        if (typeof recipient !== 'string') throw new Error('Recipient must be a string JID');

        // Auto-fix plain numbers
        if (!recipient.includes('@')) recipient = `${recipient.replace(/\D/g, '')}@c.us`;

        if (recipient.includes('@lid')) {
            const contact = await client.getContactById(recipient);
            if (contact?.id?._serialized) {
                const resolved = contact.id._serialized;
                if (resolved !== recipient) {
                    console.log(`[LID Resolution] Resolved ${recipient} -> ${resolved}`);
                    recipient = resolved;
                }
            }
        }

        console.log(`[Outgoing] Sending to ${recipient}: ${typeof text === 'string' ? text.slice(0, 60).replace(/\n/g, ' ') + '...' : '[Media]'}`);
        const result = await client.sendMessage(recipient, text, options);
        await delay(OUTBOUND_DELAY_MS);
        return result;
    } catch (err) {
        console.error(`Failed to send message to ${to}:`, err.message);
        throw err;
    }
}

/**
 * Sends the main welcome menu.
 */
async function sendMainMenu(from) {
    const lang = getUserLang(from);
    const text = t(lang, 'menu.text', { schoolName: SCHOOL_NAME });
    return await sendWA(from, text);
}

function startLanguageSelectionSession(from, existingData = {}) {
    const preserved = {};
    if (existingData.contactId) preserved.contactId = existingData.contactId;
    userHistory.delete(from);
    userStates.set(from, STATES.LANGUAGE);
    userData.set(from, { ...preserved, lastSeen: Date.now() });
}

/**
 * Adds a student to a WhatsApp group by ID.
 */
async function addStudentToGroup(groupId, contactId) {
    if (!groupId || !contactId) throw new Error('Invalid IDs');

    let participantId = contactId.trim();
    if (participantId.includes('@lid')) {
        const contact = await client.getContactById(participantId);
        if (contact?.id?._serialized) participantId = contact.id._serialized;
    }

    if (!participantId.includes('@')) participantId = `${participantId}@c.us`;
    if (participantId.includes('@lid')) throw new Error('Could not resolve LID');

    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) throw new Error('Invalid Group');
    return await chat.addParticipants([participantId]);
}


// --- 6. BOT EVENT HANDLERS (QR, Ready, Message) ---

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'BOT_SESSION',
        dataPath: AUTH_DIR
    }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan QR Code:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('[System] WhatsApp Client Ready! Booting up memory subsystems...');
    loadSessions();
    try {
        await executeWithRetry(async () => {
            await loadStudentsFromSheets();
        }, 5, 5000); // Try 5 times with 5-second delays if network is shaky during boot

        isSystemReady = true;
        console.log('[System] ✅ Bot is FULLY INITIALIZED and ready to process messages.');
    } catch (error) {
        console.error('\n❌ FATAL STARTUP ERROR: Could not sync with Google Sheets after multiple attempts.');
        console.error('Refusing to process WhatsApp messages with an empty or corrupt memory state.');
        console.error('Exiting process to allow PM2 to restart and try again later.\n');
        process.exit(1);
    }
});

/**
 * Robustly checks if a message sender is an administrator.
 * Handles JID/LID mismatches by checking both the direct ID and the resolved phone number.
 */
async function isUserAdmin(msg) {
    const from = msg.from;

    // 1. Resolve Contact and check Phone Number first (most reliable for LID mismatch)
    try {
        const contact = await msg.getContact();
        if (contact && contact.number) {
            const phoneJid = `${contact.number}@c.us`;
            if (ADMIN_NUMBERS.includes(phoneJid)) {
                // If the direct 'from' was an LID, it won't match ADMIN_NUMBERS[0] checks later
                // Update msg.from locally for this message processing if it's the master admin
                if (phoneJid === ADMIN_NUMBERS[0]) {
                    msg._resolvedMaster = true;
                }
                return true;
            }
        }
    } catch (e) {
        console.warn(`[Admin Check] Failed to resolve contact for ${from}:`, e.message);
    }

    // 2. Direct Match (JID or LID)
    if (ADMIN_NUMBERS.includes(from)) {
        if (from === ADMIN_NUMBERS[0]) msg._resolvedMaster = true;
        return true;
    }

    return false;
}

client.on('message', async msg => {
    if (isShuttingDown || !isSystemReady) return;
    if (msg.fromMe) return;
    const from = msg.from;
    // Hard-stop non-1:1 chats (groups, status/broadcast, channels)
    if (
        !from ||
        from.endsWith('@g.us') ||
        from.endsWith('@broadcast') ||
        from.endsWith('@newsletter') ||
        from === 'status@broadcast'
    ) return;
    if (isRateLimited(from)) return await sendWA(from, '⚠️ Too many messages too quickly. Please wait a few seconds and try again.');

    const rawBody = typeof msg.body === 'string' ? msg.body : '';
    console.log(`[Incoming] From: ${from} | Body: ${rawBody.slice(0, 60).replace(/\n/g, ' ')}${rawBody.length > 60 ? '...' : ''}`);

    try {
        const body = rawBody.trim();
        const lowerBody = body.toLowerCase();

        /**
         * ADMIN WORKFLOW
         */
        const isAdmin = await isUserAdmin(msg);
        if (isAdmin) {
            // Command: Admin Help
            if (lowerBody === 'adminhelp') {
                const help = `🛠️ *ADMIN CONTROL PANEL*

*1. Broadcast*
• \`broadcast <msg>\` - Announcement to ALL.
• \`broadcast grade <6-11> <msg>\` - Target only ONE grade.

*2. Setting Details*
• \`set school <name>\` - Change school branding.
• \`set bank name <name>\` - Change Bank.
• \`set bank accname <name>\` - Change Acc holder.
• \`set bank number <no>\` - Change Account no.
• \`set bank branch <name>\` - Change Branch.
• \`set group <6-11> <id>\` - Link a grade group.

*3. Admin Management*
• \`set admin add <id>\` - Add new admin ID.
• \`set admin remove <id>\` - Delete admin ID.

*4. Commands*
• \`settings\` - View current bot config.
• \`listadmins\` - Show all admin WhatsApp IDs.
• \`status <id>\` - Search student details.
• \`approve <id>\` - Approve student.
• \`reject <id> [reason]\` - Deny student.
• \`kick <id>\` - Remove student from group.
• \`delete student <id>\` - Remove from record.
• \`edit student <id> <field> <value>\` - Update details.
• \`getgroups\` - List all your WhatsApp groups.`;
                return await sendWA(from, help);
            }

            // Command: Settings Summary
            if (lowerBody === 'settings') {
                let summary = `⚙️ *CURRENT SETTINGS*\n\n`;
                summary += `🏫 *School:* ${SCHOOL_NAME}\n`;
                summary += `👥 *Admins:* ${ADMIN_NUMBERS.length}\n`;
                summary += `\n📦 *Groups:*\n` + GROUPS.map(g => `• ${g.name}: ${g.id || 'Not Set'}`).join('\n');
                summary += `\n\n💰 *Bank Info:*\n${getBankLabel()}`;
                return await sendWA(from, summary);
            }

            // Command: List Admins
            if (lowerBody === 'listadmins') {
                const list = `👥 *CURRENT ADMINS:*\n\n` + ADMIN_NUMBERS.map((id, i) => `${i + 1}. ${id}`).join('\n');
                return await sendWA(from, list);
            }

            // Command: Dynamic Settings (Set)
            if (lowerBody.startsWith('set ')) {
                const parts = body.split(/\s+/);
                const target = parts[1]?.toLowerCase();

                if (target === 'school') {
                    const newName = body.substring(11).trim();
                    if (!newName) return await sendWA(from, '❌ School name cannot be empty.');
                    if (updateEnvFile('SCHOOL_NAME', newName)) return await sendWA(from, `✅ School name updated to: *${newName}*`);
                }

                if (target === 'bank') {
                    const sub = parts[2]?.toLowerCase();
                    const value = body.substring(body.indexOf(parts[2]) + parts[2].length).trim();
                    if (!sub || !value) return await sendWA(from, '❌ Usage: set bank <name|accname|number|branch> <value>');
                    let key = '';
                    if (sub === 'name') key = 'BANK_NAME';
                    else if (sub === 'accname') key = 'BANK_ACC_NAME';
                    else if (sub === 'number') key = 'BANK_ACC_NUMBER';
                    else if (sub === 'branch') key = 'BANK_BRANCH';

                    if (key && updateEnvFile(key, value)) return await sendWA(from, `✅ Bank *${sub}* updated to: *${value}*`);
                    return await sendWA(from, '❌ Usage: set bank <name|accname|number|branch> <value>');
                }

                if (target === 'group') {
                    const grade = parseInt(parts[2], 10);
                    const groupId = parts[3];
                    if (Number.isInteger(grade) && grade >= 6 && grade <= 11 && groupId && updateEnvFile(`GROUP_ID_${grade}`, groupId)) {
                        return await sendWA(from, `✅ Group for *Grade ${grade}* updated.`);
                    }
                    return await sendWA(from, '❌ Usage: set group <6-11> <id>');
                }

                if (target === 'admin') {
                    const action = parts[2]?.toLowerCase();
                    let newId = parts[3];
                    if (!newId) return await sendWA(from, '❌ Missing Admin ID.');

                    // Normalize incoming ID
                    if (!newId.includes('@')) newId = `${newId.replace(/\D/g, '')}@c.us`;

                    if (action === 'add') {
                        if (ADMIN_NUMBERS.includes(newId)) return await sendWA(from, 'ℹ️ Already an admin.');
                        const updatedArray = [...ADMIN_NUMBERS, newId];
                        const newList = updatedArray.join(', ');
                        updateEnvFile('ADMIN_NUMBERS', newList);
                        return await sendWA(from, `✅ Added *${newId}* as admin.`);
                    }
                    if (action === 'remove') {
                        const isMaster = msg._resolvedMaster || from === ADMIN_NUMBERS[0];
                        if (!isMaster) return await sendWA(from, '🚫 Only the Master Admin can remove admins.');
                        if (!ADMIN_NUMBERS.includes(newId)) return await sendWA(from, '❌ This ID is not an admin.');

                        const updatedArray = ADMIN_NUMBERS.filter(id => id !== newId);
                        const newList = updatedArray.join(', ');
                        updateEnvFile('ADMIN_NUMBERS', newList || from);
                        return await sendWA(from, `✅ Removed *${newId}* from admins.`);
                    }
                }
            }

            // Command: Broadcast
            if (lowerBody.startsWith('broadcast ')) {
                let announcement = body.substring(10).trim();
                if (!announcement) return await sendWA(from, '❌ Usage: broadcast [grade X] <message>');

                let targetGrade = null;
                const gradeMatch = announcement.toLowerCase().match(/^grade\s+(\d+)\s+/);

                if (gradeMatch) {
                    targetGrade = parseInt(gradeMatch[1], 10);
                    announcement = announcement.substring(gradeMatch[0].length).trim();
                }

                let students = Array.from(registeredStudentIds.values());
                if (targetGrade) {
                    students = students.filter(s => s.grade === targetGrade);
                    if (students.length === 0) return await sendWA(from, `ℹ️ No students found in Grade ${targetGrade}.`);
                }

                await sendWA(from, `🚀 *Broadcast started* (${targetGrade ? 'Grade ' + targetGrade : 'ALL'})...`);

                let success = 0;
                for (const student of students) {
                    try {
                        if (student.contactId) {
                            await sendWA(student.contactId, announcement);
                            success++;
                            await delay(ADMIN_BROADCAST_DELAY_MS); // Anti-spam delay
                        }
                    } catch (e) { console.error(`Broadcast failed for ${student.idNumber}:`, e.message); }
                }
                return await sendWA(from, `✅ *Broadcast Finished*\nSent to ${success}/${students.length} students.`);
            }

            if (lowerBody === 'getgroups') {
                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);
                let list = '📂 *Your WhatsApp Groups:*\n\n';
                groups.forEach(g => list += `*${g.name}*\nID: ${g.id._serialized}\n\n`);
                return await sendWA(from, list || 'No groups found.');
            }

            // State: Group Selection for Approval
            const adminState = adminStates.get(from);
            if (adminState?.step === 'chooseGroup') {
                const idx = parseInt(body, 10) - 1;
                if (idx < 0 || idx >= GROUPS.length) return await sendWA(from, '❌ Invalid selection.');

                const group = GROUPS[idx];
                if (!group?.id) return await sendWA(from, `❌ ${group?.name || 'Selected group'} is not configured yet.`);
                const approval = pendingApprovals.get(adminState.studentId);
                if (!approval) { adminStates.delete(from); return await sendWA(from, '❌ No pending approval found.'); }

                try {
                    const targetAddId = approval.contactId || approval.phone;
                    await addStudentToGroup(group.id, targetAddId);
                    await sendWA(from, `✅ Student *${approval.idNumber}* added to *${group.name}*.`);
                    await sendWA(approval.contactId, `🎉 *APPROVED!* The student (${approval.idNumber}) has been added to the ${group.name} group.`);

                    approval.status = 'Approved';
                    approval.groupId = group.id;
                    await upsertStudentData(approval, 'Approved');
                    pendingApprovals.delete(adminState.studentId);
                    adminStates.delete(from);
                } catch (error) {
                    await sendWA(from, `❌ Failed: ${error.message}`);
                }
                return;
            }

            // Command: Approve Student
            if (lowerBody.startsWith('approve')) {
                const parts = body.split(/\s+/);
                let studentId = parts[1] ? normalizeStudentId(parts[1]) : null;

                if (!studentId && pendingApprovals.size === 1) studentId = Array.from(pendingApprovals.keys())[0];
                if (!studentId || !pendingApprovals.has(studentId)) {
                    return await sendWA(from, `❓ Student ID missing or not pending. Command: approve <id>`);
                }

                const approval = pendingApprovals.get(studentId);
                adminStates.set(from, { step: 'chooseGroup', studentId });
                const list = GROUPS.map((g, i) => `${i + 1}. ${g.name}`).join('\n');

                let detailMsg = `📌 Approve *${studentId}* (${approval.name})\n`;
                detailMsg += `Grade: ${approval.grade} | Month: ${approval.months}\n`;
                detailMsg += `Tutes: ${approval.wantsTutes ? 'Yes' : 'No'} | Fee: LKR ${approval.fee || approval.totalFee || '1500/2500'}\n\n`;
                detailMsg += `Select group:\n\n${list}`;

                return await sendWA(from, detailMsg);
            }

            // Command: Reject Student
            if (lowerBody.startsWith('reject ')) {
                const parts = body.split(/\s+/);
                const studentId = normalizeStudentId(parts[1]);
                const reason = body.substring(body.indexOf(parts[1]) + parts[1].length).trim() || 'Details/Payment incorrect.';

                if (!pendingApprovals.has(studentId)) return await sendWA(from, '❌ Student not found in pending list.');

                const student = pendingApprovals.get(studentId);
                await sendWA(student.contactId, `❌ *REGISTRATION REJECTED*\n\nReason: ${reason}\n\nPlease fix and resubmit.`);

                student.status = 'Rejected';
                await upsertStudentData(student, 'Rejected');
                pendingApprovals.delete(studentId);
                return await sendWA(from, `✅ Student *${studentId}* rejected.`);
            }

            // Command: Status Search
            if (lowerBody.startsWith('status ')) {
                const studentId = normalizeStudentId(body.substring(7));
                const student = registeredStudentIds.get(studentId);
                if (!student) return await sendWA(from, '❌ Student not found.');

                let details = `👤 *STUDENT STATUS: ${studentId}*\n\n`;
                details += `Name: ${student.name}\nSchool: ${student.school || 'N/A'}\nGrade: ${student.grade}\nMonth: ${student.months}\nStatus: *${student.status}*`;
                if (student.groupId) details += `\nGroup: ${student.groupId}`;
                return await sendWA(from, details);
            }

            // Command: Kick Student
            if (lowerBody.startsWith('kick ')) {
                const parts = body.split(/\s+/);
                const studentId = normalizeStudentId(parts[1]);
                const reason = body.substring(body.indexOf(parts[1]) + parts[1].length).trim() || 'No reason specified.';

                const student = registeredStudentIds.get(studentId);
                if (!student) return await sendWA(from, '❌ Student not found.');
                if (!student.groupId) return await sendWA(from, '❌ Student is not recorded in any group.');

                try {
                    const chat = await client.getChatById(student.groupId);
                    const me = chat.participants.find(p => p.id._serialized === client.info.me._serialized || p.id.user === client.info.wid.user);
                    if (!me || !me.isAdmin) return await sendWA(from, "❌ Action failed: I am not an admin in that group.");

                    await chat.removeParticipants([student.contactId]);

                    // Notify the student
                    await sendWA(student.contactId, `🚫 *ACCESS REMOVED*\n\nYou have been removed from the class group.\n\nReason: ${reason}\n\nIf you believe this is a mistake, please contact the tutor.`);

                    // Update status in Sheets and memory
                    student.status = 'Kicked';
                    await upsertStudentData(student, 'Kicked');

                    return await sendWA(from, `👢 Student *${studentId}* kicked.\nNotification sent to student.\nReason: ${reason}`);
                } catch (e) { return await sendWA(from, `❌ Kick failed: ${e.message}`); }
            }

            // Command: Delete Student
            if (lowerBody.startsWith('delete student ')) {
                const isMaster = msg._resolvedMaster || from === ADMIN_NUMBERS[0];
                if (!isMaster) return await sendWA(from, '🚫 Only Master Admin can delete.');
                const studentId = normalizeStudentId(body.substring(15));
                const student = registeredStudentIds.get(studentId);
                if (!student) return await sendWA(from, '❌ Student not found.');

                student.status = 'DELETED';
                await upsertStudentData(student, 'DELETED');
                registeredStudentIds.delete(studentId);
                return await sendWA(from, `🗑️ Student *${studentId}* deleted from bot memory.`);
            }

            // Command: Edit Student Details
            if (lowerBody.startsWith('edit student ')) {
                const parts = body.split(/\s+/);
                if (parts.length < 5) return await sendWA(from, '❌ Usage: edit student <id> <field> <value>\n\nFields: name, school, grade, phone, email, address, status, month');

                const studentId = normalizeStudentId(parts[2]);
                const field = parts[3].toLowerCase();
                const value = parts.slice(4).join(' ').trim();

                const student = registeredStudentIds.get(studentId);
                if (!student) return await sendWA(from, '❌ Student not found.');

                const validFields = ['name', 'school', 'grade', 'phone', 'email', 'address', 'status', 'month'];
                if (!validFields.includes(field)) return await sendWA(from, `❌ Invalid field. Valid fields: ${validFields.join(', ')}`);

                // Capture original values for Cleanup logic
                const originalGrade = student.grade;
                const originalMonth = student.months;

                // Update memory
                if (field === 'name') student.name = value;
                else if (field === 'school') student.school = value;
                else if (field === 'grade') {
                    const g = parseInt(value, 10);
                    if (isNaN(g) || g < 6 || g > 11) return await sendWA(from, '❌ Grade must be between 6 and 11.');
                    student.grade = g;
                }
                else if (field === 'phone') {
                    if (!isValidPhone(value)) return await sendWA(from, '❌ Invalid phone.');
                    student.phone = cleanPhoneNumber(value);
                    student.contactId = `${student.phone}@c.us`;
                }
                else if (field === 'email') {
                    if (!isValidEmail(value)) return await sendWA(from, '❌ Invalid email.');
                    student.email = value;
                }
                else if (field === 'address') student.address = value;
                else if (field === 'status') student.status = value;
                else if (field === 'month') {
                    const resolved = resolveMonthInput(value);
                    if (!resolved) return await sendWA(from, '❌ Invalid month format.');
                    student.months = resolved;
                }

                try {
                    // Pass current values as 'old' values if they're about to change
                    const oldG = field === 'grade' ? originalGrade : null;
                    const oldM = field === 'month' ? originalMonth : null;

                    await upsertStudentData(student, null, oldG, oldM);
                    return await sendWA(from, `✅ Student *${studentId}* updated: ${field} -> *${value}*`);
                } catch (e) {
                    return await sendWA(from, `❌ Failed to update Sheets: ${e.message}`);
                }
            }

            return;
        }

        /**
         * STUDENT WORKFLOW
         */

        // Global Keywords
        if (lowerBody === MENU_KEYWORD) {
            const previous = userData.get(from) || {};
            startLanguageSelectionSession(from, previous);
            return await sendWA(from, t(LANG.EN, 'language.prompt'));
        }
        if (lowerBody === 'cancel') {
            const previous = userData.get(from) || {};
            const lang = getUserLang(from);
            startLanguageSelectionSession(from, previous);
            const cancelMsg = `${t(lang, 'start.cancelled')}\n\n${t(LANG.EN, 'language.prompt')}`;
            return await sendWA(from, cancelMsg);
        }

        // Session Initialization
        if (!userStates.has(from)) {
            let contactId = from;
            if (from.includes('@lid')) {
                try { const contact = await msg.getContact(); contactId = contact.id._serialized; } catch (e) { }
            }
            const savedLang = userLangPref.get(from);
            if (savedLang) {
                // Returning user — skip language selection, go straight to menu
                userHistory.delete(from);
                userStates.set(from, STATES.START);
                userData.set(from, { contactId, lang: savedLang, lastSeen: Date.now() });
                return await sendMainMenu(from);
            }
            startLanguageSelectionSession(from, { contactId });
            return await sendWA(from, t(LANG.EN, 'language.prompt'));
        }

        const state = userStates.get(from);
        const data = userData.get(from);
        data.lastSeen = Date.now();

        if (!data.lang && state !== STATES.LANGUAGE) {
            userStates.set(from, STATES.LANGUAGE);
            return await sendWA(from, t(LANG.EN, 'language.prompt'));
        }

        // Command: Back
        if (lowerBody === 'back') {
            const currentState = userStates.get(from);
            if (currentState === STATES.CONFIRM) return await sendWA(from, t(getUserLang(from), 'start.cannotBackAfterReceipt'));

            let options = [];
            let stageCount = 0;
            if (data.isNewStudent) {
                options = [
                    '1. Name',
                    '2. School',
                    '3. Email',
                    '4. Phone',
                    '5. Grade',
                    '6. Month',
                    '7. Tute Choice'
                ];
                if (currentState === STATES.SCHOOL) stageCount = 1;
                else if (currentState === STATES.EMAIL) stageCount = 2;
                else if (currentState === STATES.PHONE) stageCount = 3;
                else if (currentState === STATES.GRADE) stageCount = 4;
                else if (currentState === STATES.MONTHS) stageCount = 5;
                else if (currentState === STATES.TUTES_OPTION) stageCount = 6;
                else if ([STATES.ADDRESS, STATES.RECEIPT].includes(currentState)) stageCount = 7;
            } else {
                options = [
                    '1. Student ID',
                    '2. Tute Choice',
                    '3. Month'
                ];
                if ([STATES.OLD_CONFIRM, STATES.OLD_TUTES_OPTION].includes(currentState)) stageCount = 1;
                else if (currentState === STATES.OLD_MONTH) stageCount = 2;
                else if (currentState === STATES.RECEIPT) stageCount = 3;
            }

            const filteredOptions = options.slice(0, stageCount);
            if (filteredOptions.length === 0) return await sendMainMenu(from);

            data.maxBackStage = stageCount; // Security: store max allowed choice
            userStates.set(from, STATES.BACK_MENU);
            return await sendWA(from, t(getUserLang(from), 'backMenu.title', { options: filteredOptions.join('\n') }));
        }

        // --- State Machine ---
        switch (state) {
            case STATES.LANGUAGE: {
                const normalized = lowerBody.replace(/\s+/g, '');
                if (lowerBody === 'back') {
                    if (data.lang) {
                        userStates.set(from, STATES.START);
                        return await sendMainMenu(from);
                    }
                    return await sendWA(from, t(LANG.EN, 'language.prompt'));
                }
                const pickedEn = body === '1' || normalized === 'english' || normalized === 'en';
                const pickedSi = body === '2' || normalized === 'sinhala' || normalized === 'singlish' || normalized === 'සිංහල' || normalized === 'si';
                if (!pickedEn && !pickedSi) return await sendWA(from, t(LANG.EN, 'language.invalid'));

                const hadPreviousLanguage = !!data.lang;
                data.lang = pickedSi ? LANG.SI : LANG.EN;
                userLangPref.set(from, data.lang); // Remember for future sessions
                userStates.set(from, STATES.START);
                if (hadPreviousLanguage) {
                    await sendWA(from, t(data.lang, 'language.changed'));
                }
                return await sendMainMenu(from);
            }

            case STATES.START:
                if (body === '1' || lowerBody.includes('admission')) {
                    pushHistory(from, state, data);
                    data.isNewStudent = true;
                    userStates.set(from, STATES.NAME);
                    return await sendWA(from, t(getUserLang(from), 'start.newAdmissionPrompt'));
                }
                if (body === '2' || lowerBody.includes('monthly')) {
                    pushHistory(from, state, data);
                    data.isNewStudent = false;
                    userStates.set(from, STATES.OLD_ID);
                    return await sendWA(from, t(getUserLang(from), 'start.monthlyPrompt'));
                }
                if (body === '3' || lowerBody.includes('complain')) {
                    pushHistory(from, state, data);
                    userStates.set(from, STATES.COMPLAIN);
                    return await sendWA(from, t(getUserLang(from), 'start.complainPrompt'));
                }
                if (body === '4' || lowerBody.includes('language')) {
                    userStates.set(from, STATES.LANGUAGE);
                    return await sendWA(from, t(getUserLang(from), 'language.prompt'));
                }
                await sendWA(from, t(getUserLang(from), 'start.pickMenuOption'));
                return await sendMainMenu(from);

            case STATES.NAME:
                if (body.length < 3) return await sendWA(from, t(getUserLang(from), 'name.invalid'));
                pushHistory(from, state, data);
                data.name = body;
                userStates.set(from, STATES.SCHOOL);
                return await sendWA(from, t(getUserLang(from), 'school.askAfterName', { name: body }));

            case STATES.SCHOOL:
                if (body.length < 2) return await sendWA(from, t(getUserLang(from), 'school.invalid'));
                pushHistory(from, state, data);
                data.school = body;
                userStates.set(from, STATES.EMAIL);
                return await sendWA(from, t(getUserLang(from), 'email.ask'));

            case STATES.EMAIL:
                if (!isValidEmail(body)) return await sendWA(from, t(getUserLang(from), 'email.invalid'));
                pushHistory(from, state, data);
                data.email = body;
                userStates.set(from, STATES.PHONE);
                return await sendWA(from, t(getUserLang(from), 'phone.ask'));

            case STATES.PHONE:
                if (!isValidPhone(body)) return await sendWA(from, t(getUserLang(from), 'phone.invalid'));
                pushHistory(from, state, data);
                data.phone = cleanPhoneNumber(body);
                userStates.set(from, STATES.GRADE);
                return await sendWA(from, t(getUserLang(from), 'grade.ask', { idLine: '' }));

            case STATES.GRADE: {
                const grade = parseInt(body, 10);
                if (isNaN(grade) || grade < 6 || grade > 11) return await sendWA(from, t(getUserLang(from), 'grade.invalid'));
                pushHistory(from, state, data);
                data.grade = grade;
                userStates.set(from, STATES.MONTHS);
                return await sendWA(from, t(getUserLang(from), 'month.ask'));
            }

            case STATES.MONTHS: {
                const resolved = resolveMonthInput(body);
                if (!resolved) return await sendWA(from, t(getUserLang(from), 'month.invalidUnrecognized'));
                pushHistory(from, state, data);
                data.months = resolved;
                userStates.set(from, STATES.TUTES_OPTION);
                return await sendWA(from, t(getUserLang(from), 'tutes.ask', { resolved }));
            }

            case STATES.TUTES_OPTION: {
                if (!['yes', 'no'].includes(lowerBody)) return await sendWA(from, t(getUserLang(from), 'yesNo.invalid'));
                const wantsT = lowerBody === 'yes';
                pushHistory(from, state, data);
                data.wantsTutes = wantsT;
                if (wantsT) {
                    userStates.set(from, STATES.ADDRESS);
                    return await sendWA(from, t(getUserLang(from), 'address.ask'));
                } else {
                    data.fee = 1500;
                    userStates.set(from, STATES.RECEIPT);
                    return await sendWA(from, t(getUserLang(from), 'fee.prompt', { fee: 1500, bankLabel: getBankLabel() }));
                }
            }

            case STATES.ADDRESS:
                pushHistory(from, state, data);
                data.address = body;
                if (data.isNewStudent) {
                    // New student: address → receipt
                    data.fee = 2500;
                    userStates.set(from, STATES.RECEIPT);
                    return await sendWA(from, t(getUserLang(from), 'fee.prompt', { fee: 2500, bankLabel: getBankLabel() }));
                } else {
                    // Old student: address → month
                    userStates.set(from, STATES.OLD_MONTH);
                    return await sendWA(from, t(getUserLang(from), 'month.ask'));
                }

            case STATES.RECEIPT:
                if (!msg.hasMedia) return await sendWA(from, t(getUserLang(from), 'receipt.needMedia'));
                try {
                    await sendWA(from, t(getUserLang(from), 'receipt.uploading'));

                    // Robust media download with retries
                    let media = null;
                    for (let i = 0; i < 3; i++) {
                        try {
                            media = await msg.downloadMedia();
                            if (media && media.data) break;
                        } catch (err) {
                            console.warn(`[Media] Download attempt ${i + 1} failed:`, err.message);
                        }
                        await delay(2000); // Wait 2s before retry
                    }

                    if (!media || !media.data) {
                        console.error('[Media] Failed to download media after 3 attempts.');
                        return await sendWA(from, t(getUserLang(from), 'receipt.uploadFail'));
                    }

                    data.receiptUrl = await uploadReceiptToDrive(media, data.idNumber, data.name || 'Student');
                    if (!data.receiptUrl) return await sendWA(from, t(getUserLang(from), 'receipt.uploadFail'));

                    saveSessionsNow(); // Persist milestone
                    data.receiptMsgId = msg.id._serialized; // Store ID for later forwarding

                    userStates.set(from, STATES.CONFIRM);
                    const addressLine = data.wantsTutes && data.address ? `\nAddress: ${data.address}` : '';
                    const preview = t(getUserLang(from), 'confirm.preview', {
                        name: data.name,
                        school: data.school || 'N/A',
                        idNumber: data.idNumber || 'New Registration',
                        month: data.months,
                        grade: data.grade,
                        tutes: data.wantsTutes ? 'Yes' : 'No',
                        addressLine
                    });
                    return await sendWA(from, preview);
                } catch (e) {
                    console.error('[Media] Error handling receipt:', e.message);
                    return await sendWA(from, t(getUserLang(from), 'receipt.uploadError'));
                }

            case STATES.CONFIRM:
                if (lowerBody === 'yes') {
                    const confirmLang = getUserLang(from);
                    await sendWA(from, t(confirmLang, 'submit.sending'));

                    // Generate Batch-based ID at the last second for NEW students
                    if (data.isNewStudent) {
                        data.idNumber = await generateBatchStudentId(data.grade);
                        saveSessionsNow(); // Persist ID assignment
                    }

                    // 1. Perform database update first! If this fails, the global catch handles it
                    // and prevents ghost records in memory.
                    await upsertStudentData(data);

                    // 2. Only update memory cache after DB confirms success
                    pendingApprovals.set(data.idNumber, { ...data, status: 'Pending' });

                    let enrollMsg = `🔔 *NEW ENROLLMENT*\nID: ${data.idNumber}\nName: ${data.name}\nSchool: ${data.school || 'N/A'}\nGrade: ${data.grade}\nPhone: ${data.phone}\nMonth: ${data.months}\nTutes: ${data.wantsTutes ? 'Yes' : 'No'}\nFee: LKR ${data.fee || data.totalFee || 'N/A'}`;
                    if (data.wantsTutes && data.address) {
                        enrollMsg += `\nAddress: ${data.address}`;
                    }
                    enrollMsg += `\nReceipt: ${data.receiptUrl}\n\n*Type "approve ${data.idNumber}" to process.*`;
                    await notifyAdmins(enrollMsg);

                    // Forward original receipt image to admins
                    if (data.receiptMsgId) {
                        try {
                            const receiptMsg = await client.getMessageById(data.receiptMsgId);
                            for (const admin of ADMIN_NUMBERS) {
                                await receiptMsg.forward(admin);
                            }
                        } catch (e) { console.warn('Failed to forward receipt:', e.message); }
                    }

                    resetUser(from);
                    return await sendWA(from, t(confirmLang, 'submit.done') + `\n\n🆔 *Your Student ID:* ${data.idNumber}`);
                }
                if (lowerBody === 'no') {
                    const cancelLang = getUserLang(from);
                    resetUser(from);
                    return await sendWA(from, t(cancelLang, 'start.cancelled'));
                }
                return await sendWA(from, t(getUserLang(from), 'confirm.reply'));

            case STATES.OLD_ID: {
                const nid = normalizeStudentId(body);
                if (!registeredStudentIds.has(nid)) return await sendWA(from, t(getUserLang(from), 'oldId.notFound', { id: nid }));
                pushHistory(from, state, data);
                const existing = registeredStudentIds.get(nid);
                Object.assign(data, existing);
                data.idNumber = nid;
                data.isNewStudent = false;
                userStates.set(from, STATES.OLD_CONFIRM);
                return await sendWA(from, t(getUserLang(from), 'oldConfirm.prompt', { name: existing.name, grade: existing.grade, phone: existing.phone }));
            }

            case STATES.OLD_CONFIRM:
                if (lowerBody === 'yes') {
                    pushHistory(from, state, data);
                    userStates.set(from, STATES.OLD_TUTES_OPTION);
                    return await sendWA(from, t(getUserLang(from), 'oldTutes.ask'));
                }
                if (lowerBody === 'no') {
                    const oldCancelLang = getUserLang(from);
                    resetUser(from);
                    return await sendWA(from, t(oldCancelLang, 'start.cancelled'));
                }
                return await sendWA(from, t(getUserLang(from), 'oldConfirm.reply'));

            case STATES.OLD_TUTES_OPTION:
                if (!['yes', 'no'].includes(lowerBody)) return await sendWA(from, t(getUserLang(from), 'yesNo.invalid'));
                pushHistory(from, state, data);
                data.wantsTutes = lowerBody === 'yes';
                if (data.wantsTutes) {
                    userStates.set(from, STATES.ADDRESS);
                    return await sendWA(from, t(getUserLang(from), 'address.ask'));
                }
                userStates.set(from, STATES.OLD_MONTH);
                return await sendWA(from, t(getUserLang(from), 'month.ask'));

            case STATES.OLD_MONTH: {
                const resolved = resolveMonthInput(body);
                if (!resolved) return await sendWA(from, t(getUserLang(from), 'month.invalid'));
                pushHistory(from, state, data);
                data.months = resolved;
                data.status = 'Pending';
                data.fee = data.wantsTutes ? 2500 : 1500;
                userStates.set(from, STATES.RECEIPT);
                const confMsg = t(getUserLang(from), 'month.confirmed', { resolved });
                const amntMsg = t(getUserLang(from), 'amount.prompt', { fee: data.fee, bankLabel: getBankLabel() });
                return await sendWA(from, `${confMsg}\n\n${amntMsg}`);
            }

            case STATES.COMPLAIN: {
                const complainLang = getUserLang(from);
                await notifyAdmins(`📣 *COMPLAIN* from ${from}:\n\n${body}`);
                await saveComplaintToSheets(from, body);
                resetUser(from);
                return await sendWA(from, t(complainLang, 'complain.done'));
            }

            case STATES.BACK_MENU: {
                const choice = parseInt(body, 10);
                const max = data.maxBackStage || 0;
                if (isNaN(choice) || choice < 1 || choice > max) {
                    const lang = getUserLang(from);
                    return await sendWA(from, data.isNewStudent ? t(lang, 'back.new.invalid') : t(lang, 'back.old.invalid'));
                }

                if (data.isNewStudent) {
                    switch (choice) {
                        case 1: userStates.set(from, STATES.NAME); return await sendWA(from, t(getUserLang(from), 'back.new.name'));
                        case 2: userStates.set(from, STATES.SCHOOL); return await sendWA(from, t(getUserLang(from), 'back.new.school'));
                        case 3: userStates.set(from, STATES.EMAIL); return await sendWA(from, t(getUserLang(from), 'back.new.email'));
                        case 4: userStates.set(from, STATES.PHONE); return await sendWA(from, t(getUserLang(from), 'back.new.phone'));
                        case 5: userStates.set(from, STATES.GRADE); return await sendWA(from, t(getUserLang(from), 'back.new.grade'));
                        case 6: userStates.set(from, STATES.MONTHS); return await sendWA(from, t(getUserLang(from), 'back.new.month'));
                        case 7: userStates.set(from, STATES.TUTES_OPTION); return await sendWA(from, t(getUserLang(from), 'back.new.tutes'));
                        default: return await sendWA(from, t(getUserLang(from), 'back.new.invalid'));
                    }
                } else {
                    switch (choice) {
                        case 1: userStates.set(from, STATES.OLD_ID); return await sendWA(from, t(getUserLang(from), 'back.old.id'));
                        case 2: userStates.set(from, STATES.OLD_TUTES_OPTION); return await sendWA(from, t(getUserLang(from), 'back.old.tutes'));
                        case 3: userStates.set(from, STATES.OLD_MONTH); return await sendWA(from, t(getUserLang(from), 'back.old.month'));
                        default: return await sendWA(from, t(getUserLang(from), 'back.old.invalid'));
                    }
                }
            }
        }
    } catch (globalError) {
        console.error(`[Message Handler] Unhandled Error processing message from ${from}:`, globalError.stack || globalError.message);

        // Safety reset to prevent the user from being permanently stuck in a corrupted state
        try {
            resetUser(from);
            await sendWA(from, `⚠️ *A system error occurred.* \nLet's try that again. Please type *menu* to restart.`);
        } catch (e) {
            console.error(`[Message Handler] Failed to send error recovery message:`, e.message);
        }
    } finally {
        saveSessions();
    }
});


// --- 7. BOT INITIALIZATION ---

client.on('auth_failure', msg => {
    console.error('❌ AUTHENTICATION FAILURE:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ BOT DISCONNECTED:', reason);
    console.log('Force exiting to allow PM2 to restart the process and recover the session.');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
    saveSessionsNow(); // Try to save state before crash
    setTimeout(() => process.exit(1), 1000);
});

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.warn(`[System] Received ${signal}. Shutting down safely...`);
    try {
        saveSessionsNow();
        if (client) {
            console.log('[WhatsApp] Destroying client...');
            await client.destroy();
        }
    } catch (err) {
        console.error('[System] Error during shutdown:', err.message);
    } finally {
        console.log('[System] Exit complete.');
        process.exit(0);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

getOAuthClient()
    .then(() => {
        console.log('Google OAuth Success. Starting Bot...');
        client.initialize().catch(err => {
            console.error('Client Initialization Error:', err.message);
        });
    })
    .catch(err => {
        console.error('OAuth Initialization Failed:', err.message);
        process.exit(1);
    });
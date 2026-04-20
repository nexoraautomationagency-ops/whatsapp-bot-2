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

// Pricing Configuration
let BASIC_FEE = parseInt(process.env.FEE_BASIC || '1500', 10);
let TUTE_FEE = parseInt(process.env.FEE_TUTE || '2500', 10);

// System Constants
const MENU_KEYWORD = 'menu';
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 Hour inactivity
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const MESSAGE_RATE_WINDOW_MS = 15 * 1000;
const MESSAGE_RATE_MAX = 10;
const ADMIN_BROADCAST_DELAY_MS = 800;
const OUTBOUND_DELAY_MS = 250;

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

// System Control State
let isShuttingDown = false;
let isSystemReady = false;
let cachedOAuthClient = null;
let sessionSaveTimer = null;
let sessionSavePending = false;

// Google ID Cache for performance
const driveCache = {
    gradeFolders: new Map(), // Grade Name -> Folder ID
    monthlySheets: new Map(), // Grade+Month -> Spreadsheet ID
    sheetTitles: new Map()   // Spreadsheet ID -> Main Sheet Title
};

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
                    adminStates: Array.from(adminStates.entries())
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
            adminStates: Array.from(adminStates.entries())
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
        if (key === 'FEE_BASIC') BASIC_FEE = parseInt(value, 10);
        if (key === 'FEE_TUTE') TUTE_FEE = parseInt(value, 10);
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
    // Rules: Exactly 10 digits, starts with 0, valid SL mobile prefix
    return /^0(70|71|72|74|75|76|77|78)\d{7}$/.test(cleaned);
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
let approvalQueue = Promise.resolve();

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
    // Update cache
    driveCache.sheetTitles.set(spreadsheetId, sheetTitle);
    return sheetTitle;
}

/**
 * Returns the title of the first visible sheet in a spreadsheet.
 */
async function getMainSheetTitle(sheets, spreadsheetId) {
    if (driveCache.sheetTitles.has(spreadsheetId)) return driveCache.sheetTitles.get(spreadsheetId);
    
    try {
        const ss = await sheets.spreadsheets.get({ spreadsheetId });
        const title = ss.data.sheets[0].properties.title;
        driveCache.sheetTitles.set(spreadsheetId, title);
        return title;
    } catch (e) {
        console.warn(`[Sheets] Failed to get main sheet title for ${spreadsheetId}:`, e.message);
        return 'Sheet1';
    }
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
                    studentObj.fee = studentObj.wantsTutes ? TUTE_FEE : BASIC_FEE;

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
        const monthlySheetTitle = await getMainSheetTitle(sheets, monthlyFileId);

        const monthRes = await sheets.spreadsheets.values.get({ spreadsheetId: monthlyFileId, range: `${monthlySheetTitle}!A:L` });
        const monthRows = monthRes.data.values || [];
        const moIndex = monthRows.findIndex(r => normalizeStudentId(r[0]) === studentData.idNumber);

        if (moIndex >= 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: monthlyFileId,
                range: `${monthlySheetTitle}!A${moIndex + 1}:L${moIndex + 1}`,
                valueInputOption: 'RAW',
                resource: { values: rowValues }
            });
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId: monthlyFileId,
                range: `${monthlySheetTitle}!A:L`,
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
    if (driveCache.gradeFolders.has(folderName)) return driveCache.gradeFolders.get(folderName);

    const query = `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) {
        const id = response.data.files[0].id;
        driveCache.gradeFolders.set(folderName, id);
        return id;
    }

    const folder = await drive.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
        fields: 'id'
    });
    const newId = folder.data.id;
    driveCache.gradeFolders.set(folderName, newId);
    return newId;
}

/**
 * Monthly Spreadsheet Utility.
 */
async function getOrCreateMonthlySpreadsheet(drive, sheets, gradeFolderId, monthSheetName) {
    if (driveCache.monthlySheets.has(monthSheetName)) return driveCache.monthlySheets.get(monthSheetName);

    const query = `'${gradeFolderId}' in parents and name = '${monthSheetName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) {
        const id = response.data.files[0].id;
        driveCache.monthlySheets.set(monthSheetName, id);
        return id;
    }

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
    driveCache.monthlySheets.set(monthSheetName, newSpreadsheetId);
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
        const sheetTitle = await getMainSheetTitle(sheets, spreadsheetId);

        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetTitle}!A:A` });
        const rows = res.data.values || [];
        const rowIndex = rows.findIndex(r => normalizeStudentId(r[0]) === normalizeStudentId(idNumber));

        if (rowIndex >= 0) {
            console.log(`[Cleanup] Removing ${idNumber} from Grade ${grade} (${monthLabel}) at row ${rowIndex + 1}`);
            
            // Get sheet ID for batchUpdate
            const ss = await sheets.spreadsheets.get({ spreadsheetId });
            const sheet = ss.data.sheets.find(s => s.properties.title === sheetTitle);
            const sheetId = sheet ? sheet.properties.sheetId : 0;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId,
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

        const sheetTitle = await getMainSheetTitle(sheets, spreadsheetId);
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetTitle}!A:D`,
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
    const text = `Welcome to *${SCHOOL_NAME}*! 🎓\n\nPlease choose an option by typing the number:\n\n1️⃣ - New admission\n2️⃣ - Pay monthly fees\n3️⃣ - Complain\n\n💡 _Type *menu* anytime to return here._`;
    return await sendWA(from, text);
}


/**
 * Adds a student to a WhatsApp group by ID.
 */
async function addStudentToGroup(groupId, contactId) {
    if (!groupId || !contactId) throw new Error('Invalid IDs');

    let participantId = contactId.trim();
    if (participantId.includes('@lid')) {
        try {
            const contact = await client.getContactById(participantId);
            if (contact?.id?._serialized && !contact.id._serialized.includes('@lid')) {
                participantId = contact.id._serialized;
            }
        } catch (e) { console.warn(`[Group Add] LID fetch failed for ${participantId}:`, e.message); }
    }

    if (!participantId.includes('@')) participantId = `${participantId}@c.us`;
    // If still LID, try one last time using getContact which is more thorough
    if (participantId.includes('@lid')) {
        try {
            const contact = await client.getContactById(participantId);
            const resolved = contact.id?._serialized;
            if (resolved && !resolved.includes('@lid')) participantId = resolved;
        } catch (e) {}
    }

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
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1014581023-alpha.html',
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

    // 3. Fallback: If 'from' is an LID, try matching against resolved ADMIN_NUMBERS
    // This handles cases where the admin number was entered as '94xxx' but WhatsApp resolves to an LID
    if (from.includes('@lid')) {
        for (const admin of ADMIN_NUMBERS) {
            if (admin.startsWith(from.split('@')[0])) return true;
        }
    }

    return false;
}

client.on('message', async msg => {
    if (isShuttingDown) return;
    if (!isSystemReady) {
        console.log(`[System] Ignoring message from ${msg.from} because bot is still initializing.`);
        return;
    }
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
• \`set fee basic <val>\` - Set basic fee.
• \`set fee tute <val>\` - Set tute fee.
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
• \`search name <text>\` - Search students by name.
• \`approve <id>\` - Approve student.
• \`reject <id> [reason]\` - Deny student.
• \`list pending\` - Show students waiting for approval.
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

                if (target === 'fee') {
                    const sub = parts[2]?.toLowerCase();
                    const value = parts[3];
                    if (!sub || isNaN(parseInt(value))) return await sendWA(from, '❌ Usage: set fee <basic|tute> <value>');
                    
                    const envKey = sub === 'basic' ? 'FEE_BASIC' : 'FEE_TUTE';
                    if (updateEnvFile(envKey, value)) {
                        return await sendWA(from, `✅ *${sub.toUpperCase()} FEE* updated to: LKR ${value}`);
                    }
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

                approvalQueue = approvalQueue.then(async () => {
                    try {
                        const targetAddId = approval.contactId || approval.phone;
                        await addStudentToGroup(group.id, targetAddId);
                        await sendWA(from, `✅ Student *${approval.idNumber}* added to *${group.name}*.`);
                        await sendWA(approval.contactId, `🎉 *APPROVED!* You have been added to the *${group.name}* class group.`);

                        approval.status = 'Approved';
                        approval.groupId = group.id;
                        await upsertStudentData(approval, 'Approved');
                        pendingApprovals.delete(adminState.studentId);
                        adminStates.delete(from);
                    } catch (error) {
                        await sendWA(from, `❌ Failed: ${error.message}`);
                    }
                }).catch(err => {
                    console.error('[Approval Queue] Serialization error recovered:', err.message);
                });
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
                const reason = body.substring(body.indexOf(parts[1]) + parts[1].length).trim() || 'No reason specified.';

                if (!studentId || !pendingApprovals.has(studentId)) {
                    return await sendWA(from, '❌ Student ID missing or not pending.');
                }

                approvalQueue = approvalQueue.then(async () => {
                    try {
                        const student = pendingApprovals.get(studentId);
                        await sendWA(student.contactId, `❌ *REGISTRATION REJECTED*\n\nReason: ${reason}\n\nPlease fix and resubmit.`);

                        student.status = 'Rejected';
                        await upsertStudentData(student, 'Rejected');
                        pendingApprovals.delete(studentId);
                        return await sendWA(from, `✅ Student *${studentId}* rejected.`);
                    } catch (e) {
                        await sendWA(from, `❌ Rejection failed: ${e.message}`);
                    }
                }).catch(err => {
                    console.error('[Approval Queue] Rejection serialization error recovered:', err.message);
                });
                return;
            }

            // Command: List Pending
            if (lowerBody === 'list pending') {
                if (pendingApprovals.size === 0) return await sendWA(from, 'ℹ️ No students currently waiting for approval.');
                
                let list = `⏳ *PENDING APPROVALS (${pendingApprovals.size})*\n\n`;
                const sorted = Array.from(pendingApprovals.values()).sort((a,b) => (a.grade || 0) - (b.grade || 0));
                
                sorted.forEach((s, i) => {
                    list += `${i+1}. *${s.idNumber}* - ${s.name}\nGrade: ${s.grade} | Month: ${s.months}\n\n`;
                });
                list += `_Type "approve <id>" to proceed._`;
                return await sendWA(from, list);
            }

            // Command: Search by Name
            if (lowerBody.startsWith('search name ')) {
                const query = body.substring(12).trim().toLowerCase();
                if (query.length < 3) return await sendWA(from, '❌ Please enter at least 3 characters to search.');
                
                const matches = Array.from(registeredStudentIds.values())
                    .filter(s => s.name.toLowerCase().includes(query) || (s.school && s.school.toLowerCase().includes(query)));
                
                if (matches.length === 0) return await sendWA(from, `ℹ️ No students found matching "${query}".`);
                
                let list = `🔍 *SEARCH RESULTS FOR "${query}" (${matches.length})*\n\n`;
                matches.slice(0, 15).forEach((s, i) => {
                    list += `${i+1}. *${s.idNumber}* - ${s.name}\nGrade: ${s.grade} | Status: ${s.status}\n\n`;
                });
                if (matches.length > 15) list += `_...and ${matches.length - 15} more matches._`;
                
                return await sendWA(from, list);
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
                    let targetJid = student.contactId;
                    if (targetJid.includes('@lid')) {
                        const contact = await client.getContactById(targetJid);
                        if (contact?.id?._serialized && !contact.id._serialized.includes('@lid')) {
                            targetJid = contact.id._serialized;
                        }
                    }

                    const chat = await client.getChatById(student.groupId);
                    const me = chat.participants.find(p => p.id._serialized === client.info.me._serialized || p.id.user === client.info.wid.user);
                    if (!me || !me.isAdmin) return await sendWA(from, "❌ Action failed: I am not an admin in that group.");

                    await chat.removeParticipants([targetJid]);

                    // Notify the student
                    await sendWA(student.contactId, `🚫 *ACCESS REMOVED*\n\nYou have been removed from the class group.\n\nReason: ${reason}\n\nIf you believe this is a mistake, please contact Sir.`);

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
            resetUser(from);
            userStates.set(from, STATES.START);
            userData.set(from, { lastSeen: Date.now() });
            return await sendMainMenu(from);
        }
        if (lowerBody === 'cancel') {
            resetUser(from);
            return await sendWA(from, '👋 Registration cancelled. Type *menu* to start again.');
        }

        // Session Initialization
        if (!userStates.has(from)) {
            let contactId = from;
            if (from.includes('@lid')) {
                try { const contact = await msg.getContact(); contactId = contact.id._serialized; } catch (e) { }
            }
            userStates.set(from, STATES.START);
            userData.set(from, { contactId, lastSeen: Date.now() });
            return await sendMainMenu(from);
        }

        const state = userStates.get(from);
        const data = userData.get(from);
        data.lastSeen = Date.now();


        // Command: Back
        if (lowerBody === 'back') {
            if (state === STATES.CONFIRM) return await sendWA(from, '❌ Cannot go back after receipt upload.');

            let options = [];
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
            } else {
                options = [
                    '1. Student ID',
                    '2. Month',
                    '3. Tute Choice'
                ];
            }

            userStates.set(from, STATES.BACK_MENU);
            return await sendWA(from, `🔙 *EDIT MENU*\nWhere would you like to go back to?\n\n${options.join('\n')}\n\n_Type the number to jump, or *cancel* to exit._`);
        }

        // --- State Machine ---
        switch (state) {

            case STATES.START:
                if (body === '1' || lowerBody.includes('admission')) {
                    pushHistory(from, state, data);
                    data.isNewStudent = true;
                    userStates.set(from, STATES.NAME);
                    return await sendWA(from, '🤝 Welcome! Please enter your *full name* to start.\n\n🔙 _Type *back* to edit details | *menu* to exit_');
                }
                if (body === '2' || lowerBody.includes('monthly')) {
                    pushHistory(from, state, data);
                    data.isNewStudent = false;
                    userStates.set(from, STATES.OLD_ID);
                    return await sendWA(from, '🆔 Please enter your *Student ID* or *Phone Number*.\n\n🔙 _Type *back* to edit details | *menu* to exit_');
                }
                if (body === '3' || lowerBody.includes('complain')) {
                    pushHistory(from, state, data);
                    userStates.set(from, STATES.COMPLAIN);
                    return await sendWA(from, '📝 Type your complaint for the admin.');
                }
                return await sendMainMenu(from);

            case STATES.NAME:
                if (body.length < 3) return await sendWA(from, '❌ Please enter a valid full name.');
                pushHistory(from, state, data);
                data.name = body;
                userStates.set(from, STATES.SCHOOL);
                return await sendWA(from, `Nice to meet you, *${body}*!\nWhat is your *school name*?\n\n🔙 _Type *back* to edit details_`);

            case STATES.SCHOOL:
                if (body.length < 2) return await sendWA(from, '❌ Please enter a valid school name.');
                pushHistory(from, state, data);
                data.school = body;
                userStates.set(from, STATES.EMAIL);
                return await sendWA(from, '📧 Great. What is your *email address*?\n\n🔙 _Type *back* to edit details_');

            case STATES.EMAIL:
                if (!isValidEmail(body)) return await sendWA(from, '❌ Invalid email.');
                pushHistory(from, state, data);
                data.email = body;
                userStates.set(from, STATES.PHONE);
                return await sendWA(from, '📫 Got it. Now, your *phone number*?\n\n🔙 _Type *back* to edit details_');

            case STATES.PHONE:
                if (!isValidPhone(body)) return await sendWA(from, '❌ Invalid phone. Please enter a 10-digit number starting with 0 (e.g., 0771234567).');
                pushHistory(from, state, data);
                const cleanedInput = cleanPhoneNumber(body);
                data.phone = cleanedInput;

                // Recognition logic: Search for existing students with this number
                const matches = Array.from(registeredStudentIds.values()).filter(s => cleanPhoneNumber(s.phone) === cleanedInput);
                let msgText = `Grade (6-11)?\n\n🔙 _Type *back* to edit details_`;
                
                if (matches.length > 0) {
                    const studentNames = matches.map(m => m.name).join(', ');
                    msgText = `🔍 *Note:* This phone number is already registered for: *${studentNames}*.\n\nIf you are registering *another student*, please continue.\n\nGrade (6-11)?\n\n🔙 _Type *back* to edit details_`;
                }

                userStates.set(from, STATES.GRADE);
                return await sendWA(from, msgText);

            case STATES.GRADE: {
                const grade = parseInt(body, 10);
                if (isNaN(grade) || grade < 6 || grade > 11) return await sendWA(from, '❌ Grades 6-11 only.');
                pushHistory(from, state, data);
                data.grade = grade;
                userStates.set(from, STATES.MONTHS);
                return await sendWA(from, '🗓️ Month (e.g. April)?\n\n🔙 _Type *back* to edit details_');
            }

            case STATES.MONTHS: {
                const resolved = resolveMonthInput(body);
                if (!resolved) return await sendWA(from, `❌ Could not recognize month.`);
                pushHistory(from, state, data);
                data.months = resolved;
                userStates.set(from, STATES.TUTES_OPTION);
                return await sendWA(from, `✅ Registered for *${resolved}*.\nInclude *tutes* (yes/no)?\n\n🔙 _Type *back* to edit details_`);
            }

            case STATES.TUTES_OPTION: {
                if (!['yes', 'no'].includes(lowerBody)) return await sendWA(from, '❌ Please reply with "yes" or "no".');
                const wantsT = lowerBody === 'yes';
                pushHistory(from, state, data);
                data.wantsTutes = wantsT;
                if (wantsT) {
                    userStates.set(from, STATES.ADDRESS);
                    return await sendWA(from, '🏠 Enter your *full shipping address*.\n\n🔙 _Type *back* to edit details_');
                } else {
                    data.fee = BASIC_FEE;
                    userStates.set(from, STATES.RECEIPT);
                    return await sendWA(from, `💰 *Fee:* LKR ${BASIC_FEE}\n\n${getBankLabel()}\n\n📸 Upload *receipt*.\n\n🔙 _Type *back* to edit details_`);
                }
            }

            case STATES.ADDRESS:
                pushHistory(from, state, data);
                data.address = body;
                if (data.isNewStudent) {
                    data.fee = TUTE_FEE;
                    userStates.set(from, STATES.RECEIPT);
                    return await sendWA(from, `💰 *Fee:* LKR ${TUTE_FEE}\n\n${getBankLabel()}\n\n📸 Upload *receipt*.\n\n🔙 _Type *back* to edit details_`);
                } else {
                    userStates.set(from, STATES.OLD_MONTH);
                    return await sendWA(from, '🗓️ Month (e.g. April)?\n\n🔙 _Type *back* to edit details_');
                }

            case STATES.RECEIPT:
                if (!msg.hasMedia) return await sendWA(from, '❌ Send receipt as image/PDF.');
                try {
                    await sendWA(from, '⏳ _Uploading..._');

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
                        return await sendWA(from, '⚠️ Receipt upload failed. Please try again with a clear JPG/PNG/PDF.');
                    }

                    data.receiptUrl = await uploadReceiptToDrive(media, data.idNumber, data.name || 'Student');
                    if (!data.receiptUrl) return await sendWA(from, '⚠️ Receipt upload failed. Please try again with a clear JPG/PNG/PDF.');

                    saveSessionsNow(); // Persist milestone
                    data.receiptMsgId = msg.id._serialized; // Store ID for later forwarding

                    userStates.set(from, STATES.CONFIRM);
                    let preview = `📋 *PREVIEW*\n\nName: ${data.name}\nSchool: ${data.school || 'N/A'}\nID: ${data.idNumber || 'New Registration'}\nMonth: ${data.months}\nGrade: ${data.grade}\nTutes: ${data.wantsTutes ? 'Yes' : 'No'}`;
                    if (data.wantsTutes && data.address) {
                        preview += `\nAddress: ${data.address}`;
                    }
                    preview += `\n\n*Reply "yes" to submit or "menu" to restart.*`;
                    return await sendWA(from, preview);
                } catch (e) {
                    console.error('[Media] Error handling receipt:', e.message);
                    return await sendWA(from, '⚠️ Error uploading receipt.');
                }

            case STATES.CONFIRM:
                if (lowerBody === 'yes') {
                    await sendWA(from, '🚀 Submitting...');

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
                    return await sendWA(from, `✅ Admission submitted for approval.\n\n🆔 *Your Student ID:* ${data.idNumber}`);
                }
                if (lowerBody === 'no') {
                    resetUser(from);
                    return await sendWA(from, '👋 Session cancelled. Type *menu* to start again.');
                }
                return await sendWA(from, 'Reply "yes" or "menu".');

            case STATES.OLD_ID: {
                let nid = normalizeStudentId(body);
                let existing = registeredStudentIds.get(nid);

                // Smart Login: If ID not found, try searching by Phone Number
                if (!existing) {
                    // Validate raw body (must start with 0) before cleaning it
                    if (isValidPhone(body)) {
                        const cleanedInput = cleanPhoneNumber(body);
                        const matches = Array.from(registeredStudentIds.values()).filter(s => cleanPhoneNumber(s.phone) === cleanedInput);
                        if (matches.length === 1) {
                            existing = matches[0];
                            nid = existing.idNumber;
                            await sendWA(from, `🔍 *ID Found!* Your registered ID is *${nid}* (${existing.name}).`);
                        } else if (matches.length > 1) {
                            let list = `🔍 *Multiple students found for this phone:*\n\n`;
                            const sortedMatches = matches.sort((a, b) => a.idNumber.localeCompare(b.idNumber));
                            sortedMatches.forEach(m => list += `• *${m.idNumber}* - ${m.name}\n`);
                            list += `\n_Please type the specific *Student ID* you want to pay for to continue._`;
                            return await sendWA(from, list);
                        }
                    }
                }

                if (!existing) return await sendWA(from, `❌ No student found with ID or Phone: *${body}*.\n\nIf you are a new student, please type *menu* and choose option 1 to get an admission, or contact Sir.`);
                pushHistory(from, state, data);
                Object.assign(data, existing);
                data.idNumber = nid;
                data.isNewStudent = false;
                userStates.set(from, STATES.OLD_CONFIRM);
                return await sendWA(from, `👋 Welcome back, *${existing.name}*!\nGrade: ${existing.grade}\nPhone: ${existing.phone}\n\n*Reply "yes" or "no".*\n\n🔙 _Type *back* to edit details_`);
            }

            case STATES.OLD_CONFIRM:
                if (lowerBody === 'yes') {
                    pushHistory(from, state, data);
                    userStates.set(from, STATES.OLD_TUTES_OPTION);
                    return await sendWA(from, '📦 Include *tutes* (yes/no)?\n\n🔙 _Type *back* to edit details_');
                }
                if (lowerBody === 'no') {
                    userStates.set(from, STATES.OLD_ID);
                    return await sendWA(from, '🔍 Please enter your *Student ID* or *Phone Number* again.');
                }
                return await sendWA(from, 'Reply "yes" or "back".');

            case STATES.OLD_TUTES_OPTION:
                if (!['yes', 'no'].includes(lowerBody)) return await sendWA(from, '❌ Please reply with "yes" or "no".');
                pushHistory(from, state, data);
                data.wantsTutes = lowerBody === 'yes';
                if (data.wantsTutes) {
                    userStates.set(from, STATES.ADDRESS);
                    return await sendWA(from, '🏠 Shipping address?');
                }
                userStates.set(from, STATES.OLD_MONTH);
                return await sendWA(from, '🗓️ Month (e.g. April)?\n\n🔙 _Type *back* to edit details_');

            case STATES.OLD_MONTH: {
                const resolved = resolveMonthInput(body);
                if (!resolved) return await sendWA(from, '❌ Invalid month.');
                pushHistory(from, state, data);
                data.months = resolved;
                data.status = 'Pending';
                data.fee = data.wantsTutes ? TUTE_FEE : BASIC_FEE;
                userStates.set(from, STATES.RECEIPT);
                return await sendWA(from, `✅ Registered for *${resolved}*.\n\n💰 *Amount:* LKR ${data.fee}\n\n${getBankLabel()}\n\n📸 Upload receipt.`);
            }

            case STATES.COMPLAIN:
                await notifyAdmins(`📣 *COMPLAIN* from ${from}:\n\n${body}`);
                await saveComplaintToSheets(from, body);
                resetUser(from);
                return await sendWA(from, '✅ Sent to admin. Thank you!');

            case STATES.BACK_MENU: {
                const choice = parseInt(body, 10);
                if (data.isNewStudent) {
                    switch (choice) {
                        case 1: userStates.set(from, STATES.NAME); return await sendWA(from, '🤝 Please enter your *full name*.');
                        case 2: userStates.set(from, STATES.SCHOOL); return await sendWA(from, '🏫 What is your *school name*?');
                        case 3: userStates.set(from, STATES.EMAIL); return await sendWA(from, '📧 What is your *email address*?');
                        case 4: userStates.set(from, STATES.PHONE); return await sendWA(from, '📫 What is your *phone number*?');
                        case 5: userStates.set(from, STATES.GRADE); return await sendWA(from, '🎓 Which *Grade* (6-11)?');
                        case 6: userStates.set(from, STATES.MONTHS); return await sendWA(from, '🗓️ Which *month* (e.g. April)?');
                        case 7: userStates.set(from, STATES.TUTES_OPTION); return await sendWA(from, '📦 Include *tutes* (yes/no)?');
                        default: return await sendWA(from, '❌ Invalid choice. Please type a number (1-7) from the menu.');
                    }
                } else {
                    switch (choice) {
                        case 1: userStates.set(from, STATES.OLD_ID); return await sendWA(from, '🆔 Please enter your *Student ID* (e.g. 310001).');
                        case 2: userStates.set(from, STATES.OLD_MONTH); return await sendWA(from, '🗓️ Which *month* (e.g. April)?');
                        case 3: userStates.set(from, STATES.OLD_TUTES_OPTION); return await sendWA(from, '📦 Include *tutes* (yes/no)?');
                        default: return await sendWA(from, '❌ Invalid choice. Please type a number (1-3) from the menu.');
                    }
                }
            }
        }
    } catch (globalError) {
        console.error(`[Message Handler] Unhandled Error processing message from ${from}:`, globalError.stack || globalError.message);

        try {
            resetUser(from);
            await sendWA(from, `⚠️ *A system error occurred.* \nPlease type *menu* to restart.`);
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
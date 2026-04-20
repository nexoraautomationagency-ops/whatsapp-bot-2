const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file'
];

async function main() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`❌ ERROR: credentials.json not found at ${CREDENTIALS_PATH}`);
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const key = credentials.installed || credentials.web;
    if (!key) {
        console.error('❌ ERROR: Invalid credentials.json format.');
        process.exit(1);
    }

    const redirectUri = (key.redirect_uris && key.redirect_uris.length > 0) ? key.redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
    const oAuth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);

    const code = process.argv[2];

    if (!code) {
        // Step 1: Generate the auth URL
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline', // CRITICAL: Gets you a refresh_token
            prompt: 'consent',     // CRITICAL: Forces Google to show the consent screen so you get a new refresh_token
            scope: SCOPES,
        });

        console.log('\n🚀 GOOGLE AUTHENTICATION SETUP');
        console.log('==============================');
        console.log('1. Open this URL in your browser:\n');
        console.log(`   \n\x1b[36m${authUrl}\x1b[0m\n`);
        console.log('2. Log in, click "Continue" or "Advanced > Go to [App Name]" if prompted.');
        console.log('3. After authorizing, copy the "code" from the URL bar (if it redirects to localhost) or from the screen.');
        console.log('4. Run this command with your code:\n');
        console.log('   \x1b[33mnode generate_token.js YOUR_AUTH_CODE_HERE\x1b[0m\n');
        process.exit(0);
    }

    // Step 2: Exchange code for token
    console.log('⏳ Exchanging code for token...');
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('\n✅ SUCCESS! token.json has been created successfully!');
        if (tokens.refresh_token) {
            console.log('📦 Refresh Token found: Yes (Your token will not expire in 7 days)');
        } else {
            console.log('⚠️ WARNING: No Refresh Token found. You might need to run this again and make sure to click "Consent" at the prompt.');
        }
        console.log(`Location: ${TOKEN_PATH}\n`);
    } catch (err) {
        console.error('\n❌ ERROR: Failed to exchange code for token:', err.message);
        if (err.message.includes('invalid_grant')) {
            console.log('TIP: The code might be expired or already used. Try generating a new URL.');
        }
    }
}

main();

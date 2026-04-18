const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Get the code from the user (Usage: node generate_token.js <code>)
const code = process.argv[2];

if (!code) {
    console.log('\n❌ ERROR: No authorization code provided.');
    console.log('Usage: node generate_token.js YOUR_CODE_HERE\n');
    process.exit(1);
}

try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`❌ ERROR: credentials.json not found at ${CREDENTIALS_PATH}`);
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const key = credentials.installed || credentials.web;
    const redirectUri = (key.redirect_uris && key.redirect_uris.length > 0) ? key.redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
    
    const oAuth2Client = new google.auth.OAuth2(
        key.client_id, key.client_secret, redirectUri
    );

    console.log('Exchanging code for token...');
    oAuth2Client.getToken(code, (err, token) => {
        if (err) {
            console.error('❌ ERROR: Failed to exchange code for token:', err.message);
            return;
        }
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
        console.log('\n✅ SUCCESS! token.json has been created successfully!');
        console.log(`Location: ${TOKEN_PATH}\n`);
    });
} catch (e) {
    console.error('❌ ERROR:', e.message);
}

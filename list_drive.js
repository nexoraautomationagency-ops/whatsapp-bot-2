const { google } = require('googleapis');
const fs = require('fs');

const TOKEN_PATH = 'token.json';

async function listFolders() {
    const content = fs.readFileSync('credentials.json');
    const credentials = JSON.parse(content);
    const key = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
    
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    
    // First, try to list folders named 'reciept' or 'receipt'
    const res = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder'",
        fields: 'files(id, name, parents)',
        spaces: 'drive'
    });
    
    console.log("All Folders:");
    res.data.files.forEach(file => {
        console.log(`${file.name} - ${file.id} (Parents: ${file.parents ? file.parents.join(', ') : 'none'})`);
    });
}

listFolders().catch(console.error);

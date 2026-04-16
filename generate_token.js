const { google } = require('googleapis');
const fs = require('fs');

const code = '4/0Aci98E8b4ldX14RVcxwsvEYyHBd9JHXeTSsz7o8U03NwDmoY0o5hvD63T-629DQQojqnvw';

try {
    const credentials = JSON.parse(fs.readFileSync('credentials.json'));
    const key = credentials.installed || credentials.web;
    const redirectUri = (key.redirect_uris && key.redirect_uris.length > 0) ? key.redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
    
    const oAuth2Client = new google.auth.OAuth2(
        key.client_id, key.client_secret, redirectUri
    );

    oAuth2Client.getToken(code, (err, token) => {
        if (err) {
            console.error('Error exchanging code for token. The code may have expired. Please click the link again and copy the new code if this fails: ', err.message);
            return;
        }
        fs.writeFileSync('token.json', JSON.stringify(token, null, 2));
        console.log('SUCCESS! token.json has been created!');
    });
} catch (e) {
    console.error('Error reading credentials:', e.message);
}

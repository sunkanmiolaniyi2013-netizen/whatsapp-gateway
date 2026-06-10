const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

async function testGHLUpload() {
    const token = 'pit-d4ce2332-82d5-4633-8109-39cfe8b74966'; // from the tenant query earlier
    const locationId = 'm2G2bfb79Bnj3ArHvLCq';

    const form = new FormData();
    // create a tiny image
    fs.writeFileSync('test.txt', 'hello world');
    form.append('file', fs.createReadStream('test.txt'));
    form.append('contactId', 'wOTaTmwCkKeh1YQzFQMF'); // Dave's contact ID from the screenshot

    try {
        const response = await axios.post(
            'https://services.leadconnectorhq.com/conversations/messages/upload',
            form,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Version': '2021-04-15',
                    ...form.getHeaders()
                }
            }
        );
        console.log('Upload success:', response.data);
    } catch (e) {
        console.error('Upload failed:', e.response ? e.response.data : e.message);
    }
}

testGHLUpload();

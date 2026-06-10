const supabase = require('./src/db/supabase');

async function testStorage() {
    console.log('Checking buckets...');
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) {
        console.error('List error:', listErr);
        return;
    }
    console.log('Buckets:', buckets.map(b => b.name));

    let bucketName = 'whatsapp_media';
    if (!buckets.find(b => b.name === bucketName)) {
        console.log(`Creating bucket ${bucketName}...`);
        const { data: createData, error: createErr } = await supabase.storage.createBucket(bucketName, {
            public: true,
            fileSizeLimit: 52428800 // 50MB
        });
        if (createErr) {
            console.error('Create error:', createErr);
            return;
        }
        console.log('Created bucket:', createData);
    }

    console.log('Testing upload...');
    const buffer = Buffer.from('test file content');
    const { data: uploadData, error: uploadErr } = await supabase.storage.from(bucketName).upload('test.txt', buffer, {
        contentType: 'text/plain',
        upsert: true
    });
    if (uploadErr) {
        console.error('Upload error:', uploadErr);
        return;
    }
    console.log('Uploaded:', uploadData);

    const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl('test.txt');
    console.log('Public URL:', publicUrlData.publicUrl);
}

testStorage();

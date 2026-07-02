const { google } = require('googleapis');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
}

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

/**
 * Finds a file by name in a specific folder.
 */
async function findFileInFolder(fileName, folderId) {
    const query = `name = '${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
    const response = await drive.files.list({
        q: query,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    return response.data.files || [];
}

/**
 * Uploads a new file or replaces existing file(s) with the same name in the folder.
 */
async function syncFileToDrive(fileName, fileStream, folderId) {
    const existingFiles = await findFileInFolder(fileName, folderId);

    if (existingFiles.length > 0) {
        console.log(`[Replace] ${fileName}`);
        await drive.files.update({
            fileId: existingFiles[0].id,
            media: { body: fileStream },
            supportsAllDrives: true,
        });

        for (const duplicate of existingFiles.slice(1)) {
            console.log(`[Delete] Removing duplicate ${duplicate.name} from Drive`);
            await deleteFileFromDrive(duplicate.id);
        }
        return;
    }

    console.log(`[Sync] Uploading ${fileName}`);
    await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { body: fileStream },
        supportsAllDrives: true
    });
}

/**
 * Finds a folder by name or creates it if it doesn't exist.
 */
async function findOrCreateFolder(folderName, parentId) {
    try {
        const response = await drive.files.list({
            q: `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
            fields: 'files(id, webViewLink)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        
        if (response.data.files.length > 0) return response.data.files[0];

        const newFolder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id, webViewLink',
            supportsAllDrives: true
        });
        return newFolder.data;
    } catch (err) {
        console.error(`[Drive Error] findOrCreateFolder: ${err.message}`);
        return null;
    }
}

/**
 * Permanently deletes a file from Drive.
 */
async function deleteFileFromDrive(fileId) {
    await drive.files.delete({
        fileId,
        supportsAllDrives: true,
    });
}

/**
 * Lists non-folder files in a Drive folder.
 */
async function listFilesInFolder(folderId) {
    const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    return response.data.files || [];
}

/**
 * Removes Drive files that are no longer present in Monday (matched by filename).
 */
async function removeOrphanedFiles(folderId, mondayFileNames) {
    const driveFiles = await listFilesInFolder(folderId);
    const keepNames = new Set(mondayFileNames);

    for (const driveFile of driveFiles) {
        if (keepNames.has(driveFile.name)) continue;
        console.log(`[Delete] Removing ${driveFile.name} from Drive`);
        await deleteFileFromDrive(driveFile.id);
    }
}

module.exports = {
    findOrCreateFolder,
    syncFileToDrive,
    removeOrphanedFiles,
};
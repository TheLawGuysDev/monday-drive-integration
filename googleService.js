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
 * Parses "report.pdf" / "report (2).pdf" into stem, version, and extension.
 */
function parseVersionedName(fileName) {
    const lastDot = fileName.lastIndexOf('.');
    const hasExt = lastDot > 0;
    const base = hasExt ? fileName.slice(0, lastDot) : fileName;
    const ext = hasExt ? fileName.slice(lastDot) : '';
    const match = base.match(/^(.*) \((\d+)\)$/);
    if (match) {
        return { stem: match[1], version: Number(match[2]), ext };
    }
    return { stem: base, version: 1, ext };
}

function buildVersionedName(stem, version, ext) {
    if (version <= 1) return `${stem}${ext}`;
    return `${stem} (${version})${ext}`;
}

function fileBaseKey(fileName) {
    const { stem, ext } = parseVersionedName(fileName);
    return `${stem.toLowerCase()}|${ext.toLowerCase()}`;
}

/**
 * Next free name in folder: file.pdf → file (2).pdf → file (3).pdf ...
 * Never reuses an existing name (avoids looking like a replace).
 */
async function getNextVersionedFileName(fileName, folderId) {
    const { stem, ext } = parseVersionedName(fileName);
    const driveFiles = await listFilesInFolder(folderId);
    const usedNames = new Set(driveFiles.map((f) => f.name));
    let maxVersion = 0;

    for (const driveFile of driveFiles) {
        const parsed = parseVersionedName(driveFile.name);
        if (
            parsed.stem.toLowerCase() === stem.toLowerCase() &&
            parsed.ext.toLowerCase() === ext.toLowerCase()
        ) {
            maxVersion = Math.max(maxVersion, parsed.version);
        }
    }

    // Exact same name already present → at least version 2
    if (maxVersion === 0 && [...usedNames].some((n) => n.toLowerCase() === fileName.toLowerCase())) {
        maxVersion = 1;
    }

    let nextVersion = maxVersion === 0 ? 1 : maxVersion + 1;
    let candidate = buildVersionedName(stem, nextVersion, ext);
    while ([...usedNames].some((n) => n.toLowerCase() === candidate.toLowerCase())) {
        nextVersion += 1;
        candidate = buildVersionedName(stem, nextVersion, ext);
    }
    return candidate;
}

/**
 * Finds a Drive file previously synced from a Monday asset id.
 * Skip check only — if the query fails, return null so upload can proceed.
 */
async function findFileByMondayAssetId(folderId, assetId) {
    if (!assetId) return null;
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false and appProperties has { key='mondayAssetId' and value='${String(assetId).replace(/'/g, "\\'")}' }`,
            fields: 'files(id, name)',
            pageSize: 10,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        return response.data.files?.[0] || null;
    } catch (err) {
        console.warn(`[Drive] asset lookup failed (${assetId}): ${err.message}`);
        return null;
    }
}

/**
 * Uploads a file without overwriting. Same Monday asset → skip.
 * Same filename / new asset → creates file (2), file (3), etc.
 * Applies to ALL file columns (BG Sheet, etc.) — not only staging columns.
 *
 * Dedup is by Monday assetId stored in Drive appProperties — NOT by file content.
 */
async function syncFileToDrive(fileName, fileStream, folderId, assetId = null) {
    if (assetId) {
        const alreadySynced = await findFileByMondayAssetId(folderId, assetId);
        if (alreadySynced) {
            console.log(`[Skip] ${fileName} already synced as "${alreadySynced.name}" (asset ${assetId})`);
            return alreadySynced;
        }
    }

    const uploadName = await getNextVersionedFileName(fileName, folderId);
    if (uploadName !== fileName) {
        console.log(`[Version] ${fileName} → ${uploadName} (asset ${assetId || 'n/a'})`);
    } else {
        console.log(`[Sync] Uploading ${uploadName} (asset ${assetId || 'n/a'})`);
    }

    const requestBody = {
        name: uploadName,
        parents: [folderId],
    };
    if (assetId) {
        requestBody.appProperties = { mondayAssetId: String(assetId) };
    }

    // Always create a new Drive file — never files.update (would replace content).
    const created = await drive.files.create({
        requestBody,
        media: { body: fileStream },
        fields: 'id, name',
        supportsAllDrives: true,
    });
    console.log(`[Drive] Created "${created.data.name}" (${created.data.id})`);
    return created.data;
}

/**
 * Finds a folder by name or creates it if it doesn't exist.
 */
async function findOrCreateFolder(folderName, parentId) {
    try {
        const response = await drive.files.list({
            q: `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
            fields: 'files(id, name, webViewLink)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        
        if (response.data.files.length > 0) return response.data.files[0];

        const newFolder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true
        });
        return newFolder.data;
    } catch (err) {
        console.error(`[Drive Error] findOrCreateFolder: ${err.message}`);
        return null;
    }
}

/**
 * Finds a client folder by Monday pulseId (unique id in the folder name).
 * Prefers names ending with " - {pulseId}".
 */
async function findFolderByPulseId(pulseId, parentId) {
    const id = String(pulseId);
    const response = await drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false and name contains '${id.replace(/'/g, "\\'")}'`,
        fields: 'files(id, name, webViewLink)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });

    const folders = response.data.files || [];
    const dashSuffix = ` - ${id}`;
    const parenSuffix = `(${id})`;

    return (
        folders.find((f) => f.name.endsWith(dashSuffix)) ||
        folders.find((f) => f.name.endsWith(parenSuffix)) ||
        folders.find((f) => f.name.includes(id)) ||
        null
    );
}

/**
 * Resolves the client folder by unique id (pulseId):
 * - If a folder with that id exists and the name matches → reuse it
 * - If it exists but the client name changed → rename it
 * - If it does not exist → create "Name - pulseId"
 */
async function findOrRenameClientFolder(desiredFolderName, pulseId, parentId) {
    try {
        const existing = await findFolderByPulseId(pulseId, parentId);

        if (existing) {
            if (existing.name === desiredFolderName) {
                return existing;
            }

            console.log(`[Rename] "${existing.name}" → "${desiredFolderName}"`);
            const updated = await drive.files.update({
                fileId: existing.id,
                requestBody: { name: desiredFolderName },
                fields: 'id, name, webViewLink',
                supportsAllDrives: true,
            });
            return updated.data;
        }

        return await findOrCreateFolder(desiredFolderName, parentId);
    } catch (err) {
        console.error(`[Drive Error] findOrRenameClientFolder: ${err.message}`);
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
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            fields: 'files(id, name)',
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        return response.data.files || [];
    } catch (err) {
        console.warn(`[Drive] listFilesInFolder failed: ${err.message}`);
        return [];
    }
}

/**
 * Removes Drive files whose base name is no longer present in Monday.
 * Keeps version siblings: if Monday has "report.pdf", keeps "report (2).pdf" too.
 */
async function removeOrphanedFiles(folderId, mondayFileNames) {
    const driveFiles = await listFilesInFolder(folderId);
    const keepBases = new Set(mondayFileNames.map(fileBaseKey));

    for (const driveFile of driveFiles) {
        if (keepBases.has(fileBaseKey(driveFile.name))) continue;
        console.log(`[Delete] Removing ${driveFile.name} from Drive`);
        await deleteFileFromDrive(driveFile.id);
    }
}

module.exports = {
    findOrCreateFolder,
    findOrRenameClientFolder,
    syncFileToDrive,
    removeOrphanedFiles,
};
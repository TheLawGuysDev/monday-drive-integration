require('dotenv').config();
const express = require('express');
const mondayService = require('./mondayService');
const googleService = require('./googleService');

const app = express();
app.use(express.json());

// --- CONSTANTS ---
const LINK_COLUMN_ID = "link_mm0f3036";
const PARENT_FOLDER_ID = process.env.PARENT_FOLDER_ID;
const DRIVE_UPLOAD_COLUMN_TITLE = (process.env.DRIVE_UPLOAD_COLUMN_TITLE || 'Drive Upload').toLowerCase();

function isDriveUploadColumn(columnTitle) {
    return String(columnTitle || '').trim().toLowerCase() === DRIVE_UPLOAD_COLUMN_TITLE;
}

app.post('/webhook', async (req, res) => {
    if (req.body.challenge) return res.status(200).send(req.body);
    const event = req.body.event;
    if (!event) return res.status(200).send({ message: 'No event' });

    console.log(`[Webhook] ${event.type} | Col: ${event.columnId} | Item: ${event.pulseId}`);

    try {
        const triggerUser = await mondayService.getMondayUserById(event.userId);
        if (triggerUser) {
            console.log('[Webhook] Triggered by (GraphQL users):', triggerUser);
        } else {
            console.log('[Webhook] Trigger user not resolved (userId:', event.userId, ')');
        }
    } catch (err) {
        console.error('[Webhook] getMondayUserById:', err.message);
    }

    if (['create_pulse', 'update_column_value', 'change_column_value'].includes(event.type)) {
        // Delay to allow Monday's file processing to complete
        await new Promise(r => setTimeout(r, 6000));

        try {
            const item = await mondayService.getMondayItemData(event.pulseId);
            if (!item) return res.status(200).send();

            // Folder: "Client Name - Company - pulseId" (company omitted if empty)
            const { folderName } = mondayService.buildClientFolderName({
                name: item.name,
                company: item.company,
                pulseId: event.pulseId,
            });
            const rootFolder = await googleService.findOrCreateFolder(folderName, PARENT_FOLDER_ID);
            if (!rootFolder) {
                console.error('[Critical Error] Could not create/find root folder');
                return res.status(200).send();
            }

            console.log(`[Drive] Folder: ${folderName}`);

            if (event.type === 'create_pulse' || event.columnId === LINK_COLUMN_ID) {
                await mondayService.updateMondayFolderLink(event.pulseId, event.boardId, LINK_COLUMN_ID, rootFolder.webViewLink);
            }

            const totalFiles = item.fileColumns.reduce((sum, col) => sum + col.files.length, 0);
            console.log(`[Sync] ${totalFiles} file(s) across ${item.fileColumns.length} column folder(s)`);

            for (const column of item.fileColumns) {
                const isStagingUpload = isDriveUploadColumn(column.columnTitle);
                const columnFolder = await googleService.findOrCreateFolder(column.columnTitle, rootFolder.id);
                if (!columnFolder) {
                    console.error(`[Critical Error] Could not create/find column folder: ${column.columnTitle}`);
                    continue;
                }

                console.log(`[Drive] Subfolder: ${column.columnTitle} (${column.files.length} file(s))${isStagingUpload ? ' [staging]' : ''}`);

                // Drive Upload is staging: keep files in Drive even after Monday column is cleared.
                if (!isStagingUpload) {
                    await googleService.removeOrphanedFiles(
                        columnFolder.id,
                        column.files.map((file) => file.name)
                    );
                }

                for (const file of column.files) {
                    const fileStream = await mondayService.downloadMondayFile(file.url);
                    await googleService.syncFileToDrive(file.name, fileStream.data, columnFolder.id);
                }

                // After a successful upload, clear only the "Drive Upload" Monday column.
                if (isStagingUpload) {
                    await mondayService.clearMondayFileColumn(
                        event.pulseId,
                        event.boardId,
                        column.columnId
                    );
                    console.log(`[Monday] Cleared "${column.columnTitle}" column after Drive upload`);
                }
            }

        } catch (err) {
            console.error(`[Critical Error] ${err.message}`);
        }
    }

    res.status(200).send({ message: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Project Organized: Port ${PORT}`));
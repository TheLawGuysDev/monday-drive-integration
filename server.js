require('dotenv').config();
const express = require('express');
const mondayService = require('./mondayService');
const googleService = require('./googleService');

const app = express();
app.use(express.json());

// --- CONSTANTS ---
const LINK_COLUMN_ID = "link_mm0f3036";
const PARENT_FOLDER_ID = process.env.PARENT_FOLDER_ID;
const SYNC_FROM_GROUP_TITLE =
    process.env.SYNC_FROM_GROUP_TITLE ||
    "UPDATE BG SHEET - Client Auto Emailed 'Welcome Letter'";
// Staging columns (CRM Uploads, LW Uploads): sync to Drive but keep files on Monday.
// (Clearing caused a race with the clear webhook and removed them from Files.)
const STAGING_UPLOAD_COLUMN_TITLES = new Set(
    (process.env.STAGING_UPLOAD_COLUMNS || 'CRM Uploads,LW Uploads')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);

function isStagingUploadColumn(columnTitle) {
    return STAGING_UPLOAD_COLUMN_TITLES.has(String(columnTitle || '').trim().toLowerCase());
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

    if (['create_pulse', 'update_column_value', 'change_column_value', 'move_pulse_into_group'].includes(event.type)) {
        // Delay to allow Monday's file processing to complete (skip long wait on group moves)
        const delayMs = event.type === 'move_pulse_into_group' ? 1000 : 6000;
        await new Promise(r => setTimeout(r, delayMs));

        try {
            const item = await mondayService.getMondayItemData(event.pulseId);
            if (!item) return res.status(200).send();

            const boardId = event.boardId || item.boardId;
            const boardGroups = await mondayService.getBoardGroups(boardId);
            const groupCheck = mondayService.isItemInOrAfterGroup(
                item.group,
                boardGroups,
                SYNC_FROM_GROUP_TITLE
            );

            console.log(`[GroupCheck] ${JSON.stringify({
                eventBoardId: event.boardId,
                itemBoardId: item.boardId,
                boardIdUsed: boardId,
                itemGroup: item.group,
                syncFrom: SYNC_FROM_GROUP_TITLE,
                boardGroupCount: boardGroups.length,
                ...groupCheck,
            })}`);

            if (!groupCheck.allowed) {
                console.log(
                    `[Skip] Item ${event.pulseId} blocked by group filter (${groupCheck.reason})`
                );
                return res.status(200).send({ message: 'Skipped: before sync group' });
            }

            console.log(`[Group] OK — "${groupCheck.itemGroupTitle}"`);

            // Folder: "Client Name - pulseId" (rename in place if name changes)
            const { folderName } = mondayService.buildClientFolderName({
                name: item.name,
                pulseId: event.pulseId,
            });
            const rootFolder = await googleService.findOrRenameClientFolder(
                folderName,
                event.pulseId,
                PARENT_FOLDER_ID
            );
            if (!rootFolder) {
                console.error('[Critical Error] Could not create/find root folder');
                return res.status(200).send();
            }

            console.log(`[Drive] Folder: ${rootFolder.name || folderName}`);

            if (event.type === 'create_pulse' || event.columnId === LINK_COLUMN_ID) {
                await mondayService.updateMondayFolderLink(event.pulseId, event.boardId, LINK_COLUMN_ID, rootFolder.webViewLink);
            }

            const totalFiles = item.fileColumns.reduce((sum, col) => sum + col.files.length, 0);
            console.log(`[Sync] ${totalFiles} file(s) across ${item.fileColumns.length} column folder(s)`);

            for (const column of item.fileColumns) {
                const isStagingUpload = isStagingUploadColumn(column.columnTitle);
                const columnFolder = await googleService.findOrCreateFolder(column.columnTitle, rootFolder.id);
                if (!columnFolder) {
                    console.error(`[Critical Error] Could not create/find column folder: ${column.columnTitle}`);
                    continue;
                }

                console.log(`[Drive] Subfolder: ${column.columnTitle} (${column.files.length} file(s))${isStagingUpload ? ' [staging-keep]' : ''}`);

                // Non-staging: remove Drive files no longer on Monday.
                // Staging (CRM/LW Uploads): do NOT clear Monday and do NOT orphan-delete —
                // clearing caused a race (clear webhook ate the next batch) and removed Files.
                if (!isStagingUpload) {
                    await googleService.removeOrphanedFiles(
                        columnFolder.id,
                        column.files.map((file) => file.name)
                    );
                }

                for (const file of column.files) {
                    const fileStream = await mondayService.downloadMondayFile(file.url);
                    await googleService.syncFileToDrive(
                        file.name,
                        fileStream.data,
                        columnFolder.id,
                        file.assetId
                    );
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

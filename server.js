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
// Staging columns (CRM Uploads, LW Uploads): sync to Drive, then clear the Monday column.
// Debounce prevents the clear-webhook from racing with the next upload batch.
const STAGING_UPLOAD_COLUMN_TITLES = new Set(
    (process.env.STAGING_UPLOAD_COLUMNS || 'CRM Uploads,LW Uploads')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);

/** @type {Map<string, { timer: NodeJS.Timeout, waiters: Function[], latestEvent: object }>} */
const debounceByItem = new Map();

function isStagingUploadColumn(columnTitle) {
    return STAGING_UPLOAD_COLUMN_TITLES.has(String(columnTitle || '').trim().toLowerCase());
}

/**
 * Monday often fires 2+ webhooks for one multi-file upload. Debounce per item so we
 * only sync once after the burst — avoids duplicate Drive files on first upload.
 */
function scheduleItemSync(event) {
    const itemId = String(event.pulseId);
    const delayMs =
        event.type === 'move_pulse_into_group' || event.type === 'move_pulse_into_board'
            ? 1000
            : 6000;

    let state = debounceByItem.get(itemId);
    if (!state) {
        state = { timer: null, waiters: [], latestEvent: event };
        debounceByItem.set(itemId, state);
    } else {
        console.log(`[Sync] Debounce reset for item ${itemId} (duplicate webhook coalesced)`);
        clearTimeout(state.timer);
    }

    state.latestEvent = event;

    return new Promise((resolve) => {
        state.waiters.push(resolve);
        state.timer = setTimeout(async () => {
            const { waiters, latestEvent } = state;
            debounceByItem.delete(itemId);
            try {
                await runItemSync(latestEvent);
            } catch (err) {
                console.error(`[Critical Error] ${err.message}`);
            } finally {
                waiters.forEach((w) => w());
            }
        }, delayMs);
    });
}

async function runItemSync(event) {
    const item = await mondayService.getMondayItemData(event.pulseId);
    if (!item) return;

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
        return;
    }

    console.log(`[Group] OK — "${groupCheck.itemGroupTitle}"`);

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
        return;
    }

    console.log(`[Drive] Folder: ${rootFolder.name || folderName}`);

    if (event.type === 'create_pulse' || event.columnId === LINK_COLUMN_ID) {
        await mondayService.updateMondayFolderLink(
            event.pulseId,
            event.boardId,
            LINK_COLUMN_ID,
            rootFolder.webViewLink
        );
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

        console.log(
            `[Drive] Subfolder: ${column.columnTitle} (${column.files.length} file(s))` +
            `${isStagingUpload ? ' [staging]' : ''}`
        );

        // Non-staging: remove Drive files no longer on Monday.
        // Staging: keep Drive history (no orphan-delete); clear Monday column after upload.
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

        if (isStagingUpload && column.files.length > 0) {
            await mondayService.clearMondayFileColumn(
                event.pulseId,
                event.boardId || item.boardId,
                column.columnId
            );
            console.log(
                `[Monday] Cleared "${column.columnTitle}" after uploading ${column.files.length} file(s)`
            );
        }
    }
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

    const SYNC_EVENT_TYPES = new Set([
        'create_pulse',
        'create_item',
        'update_column_value',
        'change_column_value',
        'move_pulse_into_group',
        'move_pulse_into_board',
        'item_moved_to_any_group',
        'item_moved_to_specific_group',
    ]);

    if (SYNC_EVENT_TYPES.has(event.type)) {
        await scheduleItemSync(event);
    } else {
        console.log(
            `[Webhook] Ignored event type "${event.type}" — add it to SYNC_EVENT_TYPES if needed. ` +
            `Keys: ${Object.keys(event).join(', ')}`
        );
    }

    res.status(200).send({ message: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Project Organized: Port ${PORT}`));

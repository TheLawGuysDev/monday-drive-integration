require('dotenv').config();
const express = require('express');
const { Readable } = require('stream');
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
// Only these boards enforce SYNC_FROM_GROUP_TITLE; all others sync from any group.
const GROUP_FILTER_BOARD_IDS = new Set(
    (process.env.GROUP_FILTER_BOARD_IDS || process.env.BOARD_ID || '')
        .split(',')
        .map((id) => String(id).trim())
        .filter(Boolean)
);
// Staging columns: sync to Drive, move to Archive Uploads, then clear.
const STAGING_UPLOAD_COLUMN_TITLES = new Set(
    (process.env.STAGING_UPLOAD_COLUMNS || 'CRM Uploads,LW Uploads,Archives')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);
const ARCHIVE_UPLOAD_COLUMN_TITLE = (
    process.env.ARCHIVE_UPLOAD_COLUMN_TITLE || 'Archive Uploads'
).trim();
// Stannp Files nesting by board (always, any group):
//   MJ boards → Stannp Files/DL Stannp
//   Valerie boards → Stannp Files/FU
// Fallback for unmapped boards: FU groups → FU folder; else column root.
const STANNP_FILES_COLUMN_TITLE = (
    process.env.STANNP_FILES_COLUMN_TITLE || 'Stannp Files'
).trim();
const STANNP_FU_FOLDER_NAME = (process.env.STANNP_FU_FOLDER_NAME || 'FU').trim() || 'FU';
const STANNP_DL_FOLDER_NAME = (process.env.STANNP_DL_FOLDER_NAME || 'DL Stannp').trim() || 'DL Stannp';
const STANNP_FU_GROUP_TITLES = new Set(
    (process.env.STANNP_FU_GROUP_TITLES ||
        process.env.STANNP_GROUP_SUBFOLDER_TITLES ||
        '1FU Sent|2FU Sent - Auto Email Sent')
        .split('|')
        .map((title) => mondayService.normalizeGroupTitle(title))
        .filter(Boolean)
);
/** @type {Map<string, string>} normalized board name → Drive subfolder under Stannp Files */
const STANNP_BOARD_FOLDER_BY_NAME = (() => {
    const map = new Map();
    const raw =
        process.env.STANNP_BOARD_FOLDER_MAP ||
        [
            `MJ TEST BOARD:${STANNP_DL_FOLDER_NAME}`,
            `MJ Board for Testing:${STANNP_DL_FOLDER_NAME}`,
            `Demand Letters - MJ:${STANNP_DL_FOLDER_NAME}`,
            `VALERIE TESTING BOARD:${STANNP_FU_FOLDER_NAME}`,
            `Valerie - 100% NEW AUTOMATIONS:${STANNP_FU_FOLDER_NAME}`,
        ].join('|');
    for (const entry of raw.split('|')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const boardKey = mondayService.normalizeGroupTitle(trimmed.slice(0, colon));
        const folderName = trimmed.slice(colon + 1).trim();
        if (boardKey && folderName) map.set(boardKey, folderName);
    }
    return map;
})();
// Columns that nest files under {column}/{board name} (e.g. LW Uploads, Archives)
const BOARD_NESTED_COLUMN_TITLES = new Set(
    (process.env.BOARD_NESTED_COLUMNS || 'LW Uploads')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);

/** @type {Map<string, { timer: NodeJS.Timeout, waiters: Function[], latestEvent: object }>} */
const debounceByItem = new Map();

/** @type {Map<string, string>} boardId → Archive Uploads column id */
const archiveColumnIdByBoard = new Map();

function isStagingUploadColumn(columnTitle) {
    return STAGING_UPLOAD_COLUMN_TITLES.has(String(columnTitle || '').trim().toLowerCase());
}

function isArchiveUploadColumn(columnTitle) {
    return (
        String(columnTitle || '').trim().toLowerCase() ===
        ARCHIVE_UPLOAD_COLUMN_TITLE.toLowerCase()
    );
}

function isStannpFilesColumn(columnTitle) {
    return (
        String(columnTitle || '').trim().toLowerCase() ===
        STANNP_FILES_COLUMN_TITLE.toLowerCase()
    );
}

function isBoardNestedColumn(columnTitle) {
    return BOARD_NESTED_COLUMN_TITLES.has(String(columnTitle || '').trim().toLowerCase());
}

function resolveStannpSubfolderName(boardName, itemGroup) {
    const boardKey = mondayService.normalizeGroupTitle(boardName);
    if (boardKey && STANNP_BOARD_FOLDER_BY_NAME.has(boardKey)) {
        return STANNP_BOARD_FOLDER_BY_NAME.get(boardKey);
    }

    const groupTitle = itemGroup?.title;
    if (!groupTitle) return null;

    const groupNorm = mondayService.normalizeGroupTitle(groupTitle);
    if (STANNP_FU_GROUP_TITLES.has(groupNorm)) {
        return STANNP_FU_FOLDER_NAME;
    }
    return null;
}

/**
 * Special Drive nesting:
 * - Stannp Files: board map (MJ→DL Stannp, Valerie→FU always) or FU-group fallback
 * - LW Uploads → LW Uploads/{board name}
 * - Otherwise → column folder root
 */
async function resolveColumnUploadFolder(columnTitle, columnFolder, { itemGroup, boardName } = {}) {
    if (isBoardNestedColumn(columnTitle)) {
        const name = String(boardName || '').trim() || 'Unknown Board';
        const boardFolder = await googleService.findOrCreateFolder(name, columnFolder.id);
        if (!boardFolder) {
            console.error(`[Drive] Could not create board folder under "${columnTitle}": ${name}`);
            return columnFolder;
        }
        console.log(`[Drive] ${columnTitle} → "${name}"`);
        return boardFolder;
    }

    if (!isStannpFilesColumn(columnTitle)) return columnFolder;

    const subfolderName = resolveStannpSubfolderName(boardName, itemGroup);
    if (!subfolderName) {
        console.log(
            `[Drive] Stannp Files: board "${boardName || '?'}" / group "${itemGroup?.title || '?'}"` +
            ` — upload to column root`
        );
        return columnFolder;
    }

    const nested = await googleService.findOrCreateFolder(subfolderName, columnFolder.id);
    if (!nested) {
        console.error(`[Drive] Could not create Stannp folder: ${subfolderName}`);
        return columnFolder;
    }
    console.log(
        `[Drive] Stannp Files → "${subfolderName}" (board "${boardName || '?'}", group "${itemGroup?.title || '?'}")`
    );
    return nested;
}

async function resolveArchiveColumnId(boardId) {
    const key = String(boardId);
    if (archiveColumnIdByBoard.has(key)) {
        return archiveColumnIdByBoard.get(key);
    }
    const columnId = await mondayService.findFileColumnIdByTitle(
        boardId,
        ARCHIVE_UPLOAD_COLUMN_TITLE
    );
    if (columnId) {
        archiveColumnIdByBoard.set(key, columnId);
    }
    return columnId;
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

function boardRequiresGroupFilter(boardId) {
    return GROUP_FILTER_BOARD_IDS.has(String(boardId));
}

async function runItemSync(event) {
    const item = await mondayService.getMondayItemData(event.pulseId);
    if (!item) return;

    const boardId = event.boardId || item.boardId;

    if (boardRequiresGroupFilter(boardId)) {
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
    } else {
        console.log(
            `[Group] Skipped filter for board ${boardId} (not in GROUP_FILTER_BOARD_IDS)`
        );
    }

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
        // Monday archive only — already synced via CRM/LW Uploads; skip to avoid Drive dupes.
        if (isArchiveUploadColumn(column.columnTitle)) {
            console.log(`[Skip] "${column.columnTitle}" is Monday archive (not synced to Drive)`);
            continue;
        }

        const isStagingUpload = isStagingUploadColumn(column.columnTitle);
        const columnFolder = await googleService.findOrCreateFolder(column.columnTitle, rootFolder.id);
        if (!columnFolder) {
            console.error(`[Critical Error] Could not create/find column folder: ${column.columnTitle}`);
            continue;
        }

        const uploadFolder = await resolveColumnUploadFolder(
            column.columnTitle,
            columnFolder,
            { itemGroup: item.group, boardName: item.boardName }
        );

        console.log(
            `[Drive] Subfolder: ${column.columnTitle}` +
            `${uploadFolder.id !== columnFolder.id ? ` / ${uploadFolder.name}` : ''}` +
            ` (${column.files.length} file(s))` +
            `${isStagingUpload ? ' [staging]' : ''}`
        );

        // Drive is append-only for every file column: create versions, never overwrite/delete.
        let archivedOk = true;
        for (const file of column.files) {
            const fileBuffer = await mondayService.downloadMondayFileBuffer(file.url);
            await googleService.syncFileToDrive(
                file.name,
                Readable.from(fileBuffer),
                uploadFolder.id,
                file.assetId
            );

            if (isStagingUpload) {
                const archiveColumnId = await resolveArchiveColumnId(boardId);
                if (!archiveColumnId) {
                    console.error(
                        `[Monday] Column "${ARCHIVE_UPLOAD_COLUMN_TITLE}" not found on board ${boardId}`
                    );
                    archivedOk = false;
                } else {
                    try {
                        await mondayService.addFileToMondayColumn(
                            event.pulseId,
                            archiveColumnId,
                            file.name,
                            fileBuffer
                        );
                        console.log(
                            `[Monday] Archived "${file.name}" → "${ARCHIVE_UPLOAD_COLUMN_TITLE}"`
                        );
                    } catch (err) {
                        archivedOk = false;
                        console.error(`[Monday] Archive failed for "${file.name}": ${err.message}`);
                    }
                }
            }
        }

        if (isStagingUpload && column.files.length > 0) {
            if (!archivedOk) {
                console.error(
                    `[Monday] Skipping clear of "${column.columnTitle}" — archive incomplete`
                );
            } else {
                await mondayService.clearMondayFileColumn(
                    event.pulseId,
                    boardId,
                    column.columnId
                );
                console.log(
                    `[Monday] Cleared "${column.columnTitle}" after archive (${column.files.length} file(s))`
                );
            }
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

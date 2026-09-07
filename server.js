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
// Deploy marker: 2026-08-27 — group exclusion (not Welcome Letter). Check startup log.
// Boards that skip sync for items in excluded group(s); all other groups sync.
const GROUP_EXCLUDE_GROUP_TITLES = new Set(
    (process.env.GROUP_EXCLUDE_GROUP_TITLES || '')
        .split('|')
        .map((title) => mondayService.normalizeGroupTitle(title))
        .filter(Boolean)
);
// Only these boards enforce GROUP_EXCLUDE_GROUP_TITLES; all others sync from any group.
const GROUP_FILTER_BOARD_IDS = new Set(
    (process.env.GROUP_FILTER_BOARD_IDS || process.env.BOARD_ID || '')
        .split(',')
        .map((id) => String(id).trim())
        .filter(Boolean)
);
// Staging columns: sync to Drive, move to Archives, then clear.
const STAGING_UPLOAD_COLUMN_TITLES = new Set(
    (process.env.STAGING_UPLOAD_COLUMNS || 'CRM Uploads,LW Uploads')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);
// Destination File column on Monday (not synced to Drive).
const ARCHIVE_UPLOAD_COLUMN_TITLE = (
    process.env.ARCHIVE_UPLOAD_COLUMN_TITLE || 'Archives'
).trim();
// Optional overrides: boardId:columnId|boardId:columnId
const ARCHIVE_UPLOAD_COLUMN_ID_BY_BOARD = (() => {
    const map = new Map();
    const raw = process.env.ARCHIVE_UPLOAD_COLUMN_IDS || '';
    for (const entry of raw.split('|')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const boardId = trimmed.slice(0, colon).trim();
        const columnId = trimmed.slice(colon + 1).trim();
        if (boardId && columnId) map.set(boardId, columnId);
    }
    return map;
})();
const ARCHIVE_UPLOAD_COLUMN_ID = (process.env.ARCHIVE_UPLOAD_COLUMN_ID || '').trim();
// Stannp Files nesting by board (always, any group):
//   MJ boards → Stannp Files/{STANNP_DL_FOLDER_NAME}
//   Valerie boards → Stannp Files/{STANNP_FU_FOLDER_NAME}
// Map values "DL" / "DL Stannp" / "{DL}" resolve to STANNP_DL_FOLDER_NAME;
// "FU" / "{FU}" resolve to STANNP_FU_FOLDER_NAME.
const STANNP_FILES_COLUMN_TITLE = (
    process.env.STANNP_FILES_COLUMN_TITLE || 'Stannp Files'
).trim();
const STANNP_FU_FOLDER_NAME = (process.env.STANNP_FU_FOLDER_NAME || 'FU').trim() || 'FU';
const STANNP_DL_FOLDER_NAME = (process.env.STANNP_DL_FOLDER_NAME || 'DL').trim() || 'DL';
const STANNP_FU_GROUP_TITLES = new Set(
    (process.env.STANNP_FU_GROUP_TITLES ||
        process.env.STANNP_GROUP_SUBFOLDER_TITLES ||
        '1FU Sent|2FU Sent - Auto Email Sent')
        .split('|')
        .map((title) => mondayService.normalizeGroupTitle(title))
        .filter(Boolean)
);

function resolveStannpMapFolderValue(rawFolder) {
    const value = String(rawFolder || '').trim();
    const key = value.replace(/^\{|\}$/g, '').trim().toLowerCase();
    if (key === 'dl' || key === 'dl stannp') return STANNP_DL_FOLDER_NAME;
    if (key === 'fu') return STANNP_FU_FOLDER_NAME;
    return value;
}

/** @type {Map<string, string>} normalized board name → Drive subfolder under Stannp Files */
const STANNP_BOARD_FOLDER_BY_NAME = (() => {
    const map = new Map();
    const raw =
        process.env.STANNP_BOARD_FOLDER_MAP ||
        [
            'MJ TEST BOARD:DL',
            'MJ Board for Testing:DL',
            'Demand Letters - MJ:DL',
            'VALERIE TESTING BOARD:FU',
            'Valerie - 100% NEW AUTOMATIONS:FU',
        ].join('|');
    for (const entry of raw.split('|')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const boardKey = mondayService.normalizeGroupTitle(trimmed.slice(0, colon));
        const folderName = resolveStannpMapFolderValue(trimmed.slice(colon + 1));
        if (boardKey && folderName) map.set(boardKey, folderName);
    }
    return map;
})();
// Columns that nest files under {column}/{board name} (LW Uploads, CRM Uploads)
const BOARD_NESTED_COLUMN_TITLES = new Set(
    (process.env.BOARD_NESTED_COLUMNS || 'LW Uploads,CRM Uploads')
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter(Boolean)
);
// Monday column title → Drive folder name (avoid duplicate FU* folders)
/** @type {Map<string, string>} lowercased monday title → Drive folder title */
const COLUMN_DRIVE_FOLDER_ALIASES = (() => {
    const map = new Map();
    const raw =
        process.env.COLUMN_DRIVE_FOLDER_ALIASES ||
        'FU Address Sheet:Address Sheet|FU Demand Letter:Demand Letter';
    for (const entry of raw.split('|')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const from = trimmed.slice(0, colon).trim().toLowerCase();
        const to = trimmed.slice(colon + 1).trim();
        if (from && to) map.set(from, to);
    }
    return map;
})();

function resolveDriveColumnFolderName(columnTitle) {
    const title = String(columnTitle || '').trim();
    if (!title) return title;
    return COLUMN_DRIVE_FOLDER_ALIASES.get(title.toLowerCase()) || title;
}

/** @type {Map<string, { timer: NodeJS.Timeout, waiters: Function[], latestEvent: object }>} */
const debounceByItem = new Map();

/** @type {Map<string, string>} boardId → Archives column id */
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
 * - Stannp Files: board map (MJ→DL, Valerie→FU always) or FU-group fallback
 * - LW Uploads / CRM Uploads → {column}/{board name}
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

async function resolveArchiveColumnId(boardId, item = null) {
    const key = String(boardId);
    if (archiveColumnIdByBoard.has(key)) {
        return archiveColumnIdByBoard.get(key);
    }

    const fromItem = mondayService.findFileColumnIdInBoardColumns(
        item?.boardColumns,
        ARCHIVE_UPLOAD_COLUMN_TITLE
    );
    if (fromItem) {
        archiveColumnIdByBoard.set(key, fromItem);
        console.log(
            `[Monday] Archives column from item board columns: "${fromItem}" (board ${key})`
        );
        return fromItem;
    }

    const configured =
        ARCHIVE_UPLOAD_COLUMN_ID_BY_BOARD.get(key) ||
        (ARCHIVE_UPLOAD_COLUMN_ID || null);
    if (configured) {
        archiveColumnIdByBoard.set(key, configured);
        console.log(
            `[Monday] Using configured Archives column id "${configured}" for board ${key}`
        );
        return configured;
    }

    const columnId = await mondayService.findFileColumnIdByTitle(
        boardId,
        ARCHIVE_UPLOAD_COLUMN_TITLE
    );
    if (columnId) {
        archiveColumnIdByBoard.set(key, columnId);
    } else {
        console.error(
            `[Monday] Archives lookup failed for board ${key}. ` +
                `boardColumns=${(item?.boardColumns || [])
                    .filter((c) => c.type === 'file')
                    .map((c) => `${c.title}:${c.id}`)
                    .join(', ') || '(none)'}`
        );
    }
    return columnId;
}

/** @type {Map<string, string>} boardId → Stannp Files column id */
const stannpColumnIdByBoard = new Map();

async function resolveStannpColumnId(boardId, item = null) {
    const key = String(boardId);
    if (stannpColumnIdByBoard.has(key)) {
        return stannpColumnIdByBoard.get(key);
    }

    const fromItem = mondayService.findFileColumnIdInBoardColumns(
        item?.boardColumns,
        STANNP_FILES_COLUMN_TITLE
    );
    if (fromItem) {
        stannpColumnIdByBoard.set(key, fromItem);
        return fromItem;
    }

    const columnId = await mondayService.findFileColumnIdByTitle(
        boardId,
        STANNP_FILES_COLUMN_TITLE
    );
    if (columnId) {
        stannpColumnIdByBoard.set(key, columnId);
    }
    return columnId;
}

async function resolveDebounceMs(event) {
    if (
        event.type === 'move_pulse_into_group' ||
        event.type === 'move_pulse_into_board'
    ) {
        return 1000;
    }

    const boardId = event.boardId;
    if (boardId && event.columnId) {
        const stannpId = await resolveStannpColumnId(boardId);
        if (stannpId && String(event.columnId) === String(stannpId)) {
            const ms = Number(process.env.STANNP_DEBOUNCE_MS);
            console.log(`[Sync] Stannp Files webhook — debounce ${Number.isFinite(ms) && ms >= 0 ? ms : 500}ms`);
            return Number.isFinite(ms) && ms >= 0 ? ms : 500;
        }
    }

    const defaultMs = Number(process.env.DEBOUNCE_MS);
    return Number.isFinite(defaultMs) && defaultMs > 0 ? defaultMs : 6000;
}

/**
 * Monday often fires 2+ webhooks for one multi-file upload. Debounce per item so we
 * only sync once after the burst — avoids duplicate Drive files on first upload.
 */
async function scheduleItemSync(event) {
    const itemId = String(event.pulseId);
    const delayMs = await resolveDebounceMs(event);

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
        const groupCheck = mondayService.isItemAllowedByGroupExclusion(
            item.group,
            GROUP_EXCLUDE_GROUP_TITLES
        );

        console.log(`[GroupCheck] ${JSON.stringify({
            eventBoardId: event.boardId,
            itemBoardId: item.boardId,
            boardIdUsed: boardId,
            itemGroup: item.group,
            excludedGroups: [...GROUP_EXCLUDE_GROUP_TITLES],
            ...groupCheck,
        })}`);

        if (!groupCheck.allowed) {
            console.log(
                `[Skip] Item ${event.pulseId} blocked by group exclusion (${groupCheck.reason})`
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

    const stannpColumnId = await resolveStannpColumnId(boardId, item);
    const triggeredStannp =
        stannpColumnId &&
        event.columnId &&
        String(event.columnId) === String(stannpColumnId);

    let fileColumnsToSync = [...item.fileColumns];

    if (triggeredStannp) {
        const stannpGroup = fileColumnsToSync.find((c) =>
            isStannpFilesColumn(c.columnTitle)
        );
        const stannpEmpty = !stannpGroup || stannpGroup.files.length === 0;
        if (stannpEmpty) {
            const maxAgeMs = Number(process.env.STANNP_RECALL_MAX_AGE_MS) || 10 * 60 * 1000;
            try {
                const recovered = await mondayService.recoverStannpOrphanFiles(
                    event.pulseId,
                    { maxAgeMs }
                );
                if (recovered.length) {
                    fileColumnsToSync = fileColumnsToSync.filter(
                        (c) => !isStannpFilesColumn(c.columnTitle)
                    );
                    fileColumnsToSync.push({
                        columnId: stannpColumnId,
                        columnTitle: STANNP_FILES_COLUMN_TITLE,
                        files: recovered,
                    });
                    console.log(
                        `[Stannp] Column empty — recovered ${recovered.length} file(s) from item Files`
                    );
                } else {
                    console.log(
                        '[Stannp] Column empty — no recent orphan file(s) in item Files'
                    );
                }
            } catch (err) {
                console.error(`[Stannp] Recall from item Files failed: ${err.message}`);
            }
        }
    }

    const totalFiles = fileColumnsToSync.reduce((sum, col) => sum + col.files.length, 0);
    console.log(`[Sync] ${totalFiles} file(s) across ${fileColumnsToSync.length} column folder(s)`);

    for (const column of fileColumnsToSync) {
        // Monday archive only — already synced via CRM/LW Uploads; skip to avoid Drive dupes.
        if (isArchiveUploadColumn(column.columnTitle)) {
            console.log(`[Skip] "${column.columnTitle}" is Monday archive (not synced to Drive)`);
            continue;
        }

        const isStagingUpload = isStagingUploadColumn(column.columnTitle);
        const driveFolderName = resolveDriveColumnFolderName(column.columnTitle);
        if (driveFolderName !== column.columnTitle) {
            console.log(`[Drive] Alias "${column.columnTitle}" → folder "${driveFolderName}"`);
        }
        const columnFolder = await googleService.findOrCreateFolder(driveFolderName, rootFolder.id);
        if (!columnFolder) {
            console.error(`[Critical Error] Could not create/find column folder: ${driveFolderName}`);
            continue;
        }

        const uploadFolder = await resolveColumnUploadFolder(
            driveFolderName,
            columnFolder,
            { itemGroup: item.group, boardName: item.boardName }
        );

        console.log(
            `[Drive] Subfolder: ${driveFolderName}` +
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
                const archiveColumnId = await resolveArchiveColumnId(boardId, item);
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
app.listen(PORT, () =>
    console.log(`Project Organized: Port ${PORT} | build: stannp-recall-2026-08-31`)
);

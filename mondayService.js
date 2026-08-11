const axios = require('axios');

const MONDAY_API_URL = 'https://api.monday.com/v2';
const API_VERSION = '2024-01';

function mondayHeaders() {
    return {
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': API_VERSION
    };
}

/**
 * Folder: "Client Name - pulseId"
 */
function buildClientFolderName({ name, pulseId }) {
    const clientName = String(name || '').trim() || 'Unnamed';
    return {
        folderName: `${clientName} - ${pulseId}`,
        // Unique per Monday item (pulseId) — safe to orphan-delete
        sharedClientFolder: false,
    };
}

function addFileToMap(filesByKey, { assetId, name, url }) {
    if (!name || !url) return;
    const key = assetId ? String(assetId) : `${name}::${url}`;
    if (!filesByKey.has(key)) {
        filesByKey.set(key, { name, url, assetId: assetId ? String(assetId) : null });
    }
}

/**
 * Groups files by File column title (for Drive subfolders like "BG Sheet").
 */
function collectFilesByColumn(item) {
    const byColumn = new Map();

    for (const columnValue of item.column_values || []) {
        if (!Array.isArray(columnValue.files) || columnValue.files.length === 0) continue;

        const columnId = columnValue.id;
        const columnTitle = (columnValue.column?.title || columnId || 'Files').trim();

        if (!byColumn.has(columnId)) {
            byColumn.set(columnId, {
                columnId,
                columnTitle,
                filesByKey: new Map(),
            });
        }

        const bucket = byColumn.get(columnId);
        for (const file of columnValue.files) {
            if (file.asset_id == null) continue;
            const url = file.asset?.public_url || file.asset?.url;
            addFileToMap(bucket.filesByKey, {
                assetId: file.asset_id,
                name: file.name,
                url,
            });
        }
    }

    return [...byColumn.values()]
        .map(({ columnId, columnTitle, filesByKey }) => ({
            columnId,
            columnTitle,
            files: [...filesByKey.values()],
        }))
        .filter((group) => group.files.length > 0);
}

/**
 * Fetches item name, current group, and files grouped by File column.
 */
async function getMondayItemData(itemId) {
    const query = `query {
        items (ids: [${itemId}]) {
            name
            group {
                id
                title
            }
            column_values {
                id
                text
                value
                ... on FileValue {
                    column {
                        title
                    }
                    files {
                        ... on FileAssetValue {
                            asset_id
                            name
                            asset {
                                public_url
                                url
                            }
                        }
                    }
                }
            }
        }
    }`;

    const response = await axios.post(MONDAY_API_URL, { query }, { headers: mondayHeaders() });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }

    const item = response.data.data?.items?.[0];
    if (!item) return null;

    return {
        name: item.name,
        group: item.group || null,
        fileColumns: collectFilesByColumn(item),
    };
}

/**
 * Fetches board groups with position (top → bottom order).
 */
async function getBoardGroups(boardId) {
    const query = `query {
        boards (ids: [${boardId}]) {
            groups {
                id
                title
                position
            }
        }
    }`;

    const response = await axios.post(MONDAY_API_URL, { query }, { headers: mondayHeaders() });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }

    return response.data.data?.boards?.[0]?.groups || [];
}

/**
 * True when the item is in the target group or any group after it on the board.
 */
function isItemInOrAfterGroup(itemGroup, boardGroups, targetGroupTitle) {
    if (!itemGroup?.id || !boardGroups?.length || !targetGroupTitle) return false;

    const targetTitle = String(targetGroupTitle).trim().toLowerCase();
    const target = boardGroups.find((g) => String(g.title || '').trim().toLowerCase() === targetTitle);
    if (!target) return false;

    const current = boardGroups.find((g) => String(g.id) === String(itemGroup.id));
    if (!current) return false;

    const targetPos = Number(target.position);
    const currentPos = Number(current.position);
    if (Number.isNaN(targetPos) || Number.isNaN(currentPos)) {
        return String(current.id) === String(target.id);
    }

    return currentPos >= targetPos;
}

/**
 * Updates the Link column in Monday with the Drive URL.
 */
async function updateMondayFolderLink(itemId, boardId, columnId, folderUrl) {
    const query = `mutation ($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value (item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) { id }
    }`;
    
    const value = JSON.stringify({ url: folderUrl, text: "Open Folder" });
    
    await axios.post(MONDAY_API_URL, {
        query,
        variables: { itemId: String(itemId), boardId: String(boardId), columnId, value }
    }, { headers: mondayHeaders() });
}

/**
 * Clears all files from a Monday File column (does not delete files in Drive).
 */
async function clearMondayFileColumn(itemId, boardId, columnId) {
    const query = `mutation ($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value (item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) { id }
    }`;

    const value = JSON.stringify({ clear_all: true });

    const response = await axios.post(MONDAY_API_URL, {
        query,
        variables: {
            itemId: String(itemId),
            boardId: String(boardId),
            columnId,
            value,
        }
    }, { headers: mondayHeaders() });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }
}

/**
 * Creates an item update (used to keep files visible in Monday Files after clearing a column).
 */
async function createMondayUpdate(itemId, body) {
    const query = `mutation ($itemId: ID!, $body: String!) {
        create_update (item_id: $itemId, body: $body) { id }
    }`;

    const response = await axios.post(MONDAY_API_URL, {
        query,
        variables: { itemId: String(itemId), body }
    }, { headers: mondayHeaders() });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }

    return response.data.data?.create_update?.id;
}

/**
 * Attaches a file to an update so it remains in the item Files section.
 */
async function addFileToMondayUpdate(updateId, fileName, fileBuffer) {
    const FormData = require('form-data');
    const form = new FormData();
    const query = `mutation ($file: File!) {
        add_file_to_update (update_id: ${updateId}, file: $file) { id }
    }`;

    form.append('query', query);
    form.append('map', JSON.stringify({ file: 'variables.file' }));
    form.append('file', fileBuffer, { filename: fileName });

    const response = await axios.post('https://api.monday.com/v2/file', form, {
        headers: {
            ...mondayHeaders(),
            ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }

    return response.data.data?.add_file_to_update;
}

/**
 * Downloads a file from a URL as a stream.
 */
async function downloadMondayFile(url) {
    return await axios({ method: 'get', url, responseType: 'stream' });
}

/**
 * Downloads a file from a URL as a Buffer (for Drive + re-attach to Monday update).
 */
async function downloadMondayFileBuffer(url) {
    const response = await axios({ method: 'get', url, responseType: 'arraybuffer' });
    return Buffer.from(response.data);
}

/**
 * Fetches a Monday user by id (use event.userId from the webhook payload).
 * Returns null if userId is missing or Monday sends sentinel -4 (no actor).
 */
async function getMondayUserById(userId) {
    if (userId == null || Number(userId) === -4) return null;

    const query = `query {
        users (ids: [${userId}]) {
            id
            name
            email
        }
    }`;

    const response = await axios.post(MONDAY_API_URL, { query }, { headers: mondayHeaders() });

    if (response.data.errors?.length) {
        throw new Error(response.data.errors.map((e) => e.message).join('; '));
    }
    const users = response.data.data?.users;
    return users?.[0] ?? null;
}

module.exports = {
    getMondayItemData,
    getBoardGroups,
    isItemInOrAfterGroup,
    updateMondayFolderLink,
    clearMondayFileColumn,
    createMondayUpdate,
    addFileToMondayUpdate,
    downloadMondayFile,
    downloadMondayFileBuffer,
    getMondayUserById,
    buildClientFolderName,
};
const axios = require('axios');

const MONDAY_API_URL = 'https://api.monday.com/v2';
const API_VERSION = '2024-01';

function mondayHeaders() {
    return {
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': API_VERSION
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
 * Merges item.assets with files from all File columns (deduped by asset id).
 */
function collectItemFiles(item) {
    const filesByKey = new Map();

    for (const asset of item.assets || []) {
        addFileToMap(filesByKey, {
            assetId: asset.id,
            name: asset.name,
            url: asset.public_url,
        });
    }

    for (const columnValue of item.column_values || []) {
        for (const file of columnValue.files || []) {
            if (file.asset_id == null) continue;
            const url = file.asset?.public_url || file.asset?.url;
            addFileToMap(filesByKey, {
                assetId: file.asset_id,
                name: file.name,
                url,
            });
        }
    }

    return [...filesByKey.values()];
}

/**
 * Fetches item name and all files (item assets + every File column).
 */
async function getMondayItemData(itemId) {
    const query = `query {
        items (ids: [${itemId}]) {
            name
            assets {
                id
                name
                public_url
            }
            column_values {
                ... on FileValue {
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
        files: collectItemFiles(item),
    };
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
 * Downloads a file from a URL as a stream.
 */
async function downloadMondayFile(url) {
    return await axios({ method: 'get', url, responseType: 'stream' });
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

module.exports = { getMondayItemData, updateMondayFolderLink, downloadMondayFile, getMondayUserById };
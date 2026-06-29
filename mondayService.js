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
 * Fetches item name and all associated assets from Monday.
 */
async function getMondayItemData(itemId) {
    const query = `query {
        items (ids: [${itemId}]) {
            name
            assets {
                name
                public_url
            }
        }
    }`;

    const response = await axios.post(MONDAY_API_URL, { query }, { headers: mondayHeaders() });
    return response.data.data?.items?.[0];
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
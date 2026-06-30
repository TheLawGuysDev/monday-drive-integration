require('dotenv').config();
const express = require('express');
const mondayService = require('./mondayService');
const googleService = require('./googleService');

const app = express();
app.use(express.json());

// --- CONSTANTS ---
const LINK_COLUMN_ID = "link_mm0f3036";
const PARENT_FOLDER_ID = process.env.PARENT_FOLDER_ID;

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

            const rootFolder = await googleService.findOrCreateFolder(item.name, PARENT_FOLDER_ID);
            if (!rootFolder) {
                console.error('[Critical Error] Could not create/find root folder');
                return res.status(200).send();
            }

            if (event.type === 'create_pulse' || event.columnId === LINK_COLUMN_ID) {
                await mondayService.updateMondayFolderLink(event.pulseId, event.boardId, LINK_COLUMN_ID, rootFolder.webViewLink);
            }

            console.log(`[Sync] ${item.files.length} file(s) found on item`);
            for (const file of item.files) {
                if (await googleService.fileExistsInFolder(file.name, rootFolder.id)) {
                    console.log(`[Skip] ${file.name} already exists.`);
                    continue;
                }

                console.log(`[Sync] Uploading ${file.name}`);
                const fileStream = await mondayService.downloadMondayFile(file.url);
                await googleService.uploadToDrive(file.name, fileStream.data, rootFolder.id);
            }

        } catch (err) {
            console.error(`[Critical Error] ${err.message}`);
        }
    }

    res.status(200).send({ message: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Project Organized: Port ${PORT}`));
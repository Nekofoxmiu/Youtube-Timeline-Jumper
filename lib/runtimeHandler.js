export async function handleRuntimeMessage(request, sender, sendResponse, context) {
    try {
        let { deleteAppElement, main, sidebarQuery, appPlayListContainerQuery, document } = context;
        let { extensionWorkOrNot } = await chrome.storage.sync.get('extensionWorkOrNot');
        let sidebarElm = document.querySelector(sidebarQuery);

        console.info('runtimeHandler.js:', request);
        if (request.action === 'switchExtensionOnState') {
            extensionWorkOrNot = !extensionWorkOrNot;
            await chrome.storage.sync.set({ extensionWorkOrNot: extensionWorkOrNot }, () => {
                console.info('Extension state saved:', extensionWorkOrNot);
            });

            if (extensionWorkOrNot) {
                console.info('yt-tj start.');
                sendResponse({ appstart: 'yt-tj start.' });
                if (sidebarElm) {
                    main(sidebarElm);
                } else {
                    // loop for wait sidebarElm
                    let loopCount = 0;
                    const loop = setInterval(() => {
                        loopCount++;
                        sidebarElm = document.querySelector(sidebarQuery);
                        if (sidebarElm) {
                            clearInterval(loop);
                            main(sidebarElm);
                        } else if (loopCount > 100) {
                            clearInterval(loop);
                        }
                    }, 100);
                }
            } else {
                sendResponse({ appstop: 'yt-tj stop.' });
                console.info('yt-tj stop.');
                await deleteAppElement();
            }
        }
        if (request.action === 'initializePlaylist') {
            if (extensionWorkOrNot) {
                sendResponse({ initialize: 'success' });
                if (sidebarElm) {
                    main(sidebarElm);
                } else {
                    // loop for wait sidebarElm
                    let loopCount = 0;
                    const loop = setInterval(() => {
                        loopCount++;
                        if (document.querySelector(appPlayListContainerQuery)) {
                            clearInterval(loop);
                        } else if (loopCount > 100) {
                            clearInterval(loop);
                        } else {
                            sidebarElm = document.querySelector(sidebarQuery);
                            if (sidebarElm) {
                                main(sidebarElm);
                            }
                        }
                    }, 100);
                }
            } else {
                sendResponse({ initialize: 'app-not-start' });
            }
        }
        if (request.action === 'playPlaylist') {
            const startIndex = request.startIndex || 0;
            chrome.runtime.sendMessage({ action: 'playPlaylist', startIndex }, (response) => {
                if (response.success) {
                    console.info('Playlist started successfully.');
                } else {
                    console.debug('Failed to start playlist:', response.message);
                }
            });
        }
    }
    catch (error) {
        console.error('Error handling runtime message:', error);
    }

}

'use strict';
console.log('yt-paj content.js injected');

(async () => {
    let dataClassModule;
    let playlistToolModule;
    let mouseEventHandlerModule;
    try {
        dataClassModule = await import('./lib/dataclass.js');
        playlistToolModule = await import('./lib/playlistTool.js');
        mouseEventHandlerModule = await import('./lib/mouseEventHandler.js');
    }
    catch (error) {
        console.error('Module loading failed:', error);
    }
    const getandUpdatePlaylistState = playlistToolModule.getandUpdatePlaylistState;
    const TimeSlot = dataClassModule.TimeSlot;
    const PlaylistItem = dataClassModule.PlaylistItem;
    const PlaylistState = dataClassModule.PlaylistState;
    const PlaylistTimeManager = playlistToolModule.PlaylistTimeManager;
    const MouseEventHandler = mouseEventHandlerModule.MouseEventHandler;
    
    // 建立播放列表容器
    const playlistContainer = document.createElement('div');
    playlistContainer.id = 'playlist-container';
    playlistContainer.className = 'playlist-container';

    // 建立添加到播放列表的按鈕
    const addToPlaylistButton = document.createElement('button');
    addToPlaylistButton.id = 'add-to-playlist';
    addToPlaylistButton.className = 'add-to-playlist';

    //建立播放列表內組件的容器
    const ul = document.createElement('ul');
    ul.id = 'ytj-playlist-items';

    const playlistState = new PlaylistState();
    const mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
    const playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);


    /**
     * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
     * @returns {?{TimeSlot}} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
     */
    const getCurrentVideoTime = () => {
        const video = document.querySelector('video');
        if (!video) return null;

        const videoTime = TimeSlot.fromTotalseconds(Math.floor(video.currentTime));

        return videoTime;
    };

    /**
    * 創建一個時間文本元素，用於播放列表中顯示和編輯時間。
    * @param {string} startOrEnd - 指示是創建開始時間還是結束時間的元素允許值'start','end'。
    * @returns {HTMLElement|null} 返回一個時間文本的 DOM 元素，如果沒有視頻元素則返回 null。
    */
    const createTimeTextElement = (startOrEnd) => {
        const timeObj = getCurrentVideoTime();
        if (!timeObj) {
            console.error('No video element found.');
            return null;
        }

        const itemText = document.createElement('div');
        itemText.classList.add(`ytj-playlist-item-text-${startOrEnd}`);
        itemText.innerText = timeObj.toformatString();
        itemText.setAttribute('timeat', timeObj.getTotalseconds().toString());
        itemText.contentEditable = false;
        return itemText;
    };

    //初始化並與background.js進行綁定
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'startExtension') {
            console.log("receive startExtension");
            sendResponse({ appstart: 'yt-tj start.' });
            //尋找sidebar 並開始主程式
            const sidebarQuery = '#related.style-scope.ytd-watch-flexy';
            const yttjQuery = '#playlist-container'
            const yttjContainer = document.querySelector(yttjQuery);
            const sidebarElm = document.querySelector(sidebarQuery);
            if (!yttjContainer && sidebarElm)
                main(sidebarElm);

        }
    });

    async function main(sidebarElm) {

        async function test(sidebarElm) {
            // 建立播放列表容器
            sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

            // 建立添加到播放列表的按鈕
            sidebarElm.insertBefore(addToPlaylistButton, sidebarElm.firstChild);

            // 使用事件委派來處理所有子項目的 mousedown 事件
            ul.addEventListener('mousedown', event => {
                const dragHandle = event.target.closest('.ytj-drag-handle');
                if (dragHandle) {
                    mouseEventHandler.handleDragStart(event);
                }
            });

            // 使用事件委派來處理所有子項目的點擊、編輯和保存邏輯
            playlistContainer.addEventListener('click', (event) => {
                const timeTextElement = event.target.closest('.ytj-playlist-item-text-start, .ytj-playlist-item-text-end');
                if (!timeTextElement) return;

                if (timeTextElement.contentEditable === 'true') return; // 如果已經是編輯模式，則不進行操作

                // 啟用編輯模式
                const originalText = timeTextElement.innerText;
                const originalTime = Number(timeTextElement.getAttribute('timeat'));
                timeTextElement.contentEditable = 'true';
                timeTextElement.focus();

                // 設置失去焦點事件處理
                const onBlur = () => {
                    timeTextElement.removeEventListener('blur', onBlur); // 移除本身的事件監聽器以避免重復註冊
                    timeTextElement.contentEditable = 'false';
                    playlistTimeManager.updateTimeText(timeTextElement, originalTime);
                    playlistState.state = getandUpdatePlaylistState(playlistState);
                };

                // 設置鍵盤事件，以支持保存和取消
                const onKeydown = (event) => {
                    event.stopPropagation(); // 防止事件冒泡
                    if (event.key === 'Enter') {
                        event.preventDefault(); // 防止Enter鍵的默認行為
                        timeTextElement.blur(); // 觸發失去焦點事件來保存
                    } else if (event.key === 'Escape') {
                        timeTextElement.innerText = originalText; // 恢復原始文本
                        timeTextElement.blur(); // 取消編輯
                    }
                };

                timeTextElement.addEventListener('keydown', onKeydown);
                timeTextElement.addEventListener('blur', onBlur, { once: true }); // 使用{ once: true }確保事件僅被觸發一次
            });

            /**
             * 重新渲染播放列表並設置事件委派以處理拖曳事件。
             */
            /*
            const reRenderPlaylist = () => {
                // 清空播放列表容器
                while (playlistContainer.firstChild) {
                    playlistContainer.removeChild(playlistContainer.firstChild);
                }
    
                // 使用 DocumentFragment 來一次性添加所有項目
                const fragment = document.createDocumentFragment();
                playlistState.playlistItems.forEach(item => {
                    fragment.appendChild(item);
                });
    
                ul.appendChild(fragment);
                playlistContainer.appendChild(ul);
            };
            */

            /**
            * 創建一個新的播放列表項目元素，包含拖拽處理和時間顯示。
            * @returns {HTMLElement} 一個代表播放列表項目的新元素。
            */
            const createPlaylistItem = () => {
                const newItem = document.createElement('li');
                newItem.classList.add('ytj-playlist-item');

                const dragHandle = document.createElement('div');
                dragHandle.classList.add('ytj-drag-handle');
                dragHandle.draggable = true;
                dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);
                // 添加時間標籤，用於顯示和編輯開始和結束時間
                const startTimeText = createTimeTextElement('start');
                const endTimeText = createTimeTextElement('end');

                newItem.appendChild(dragHandle);
                newItem.appendChild(startTimeText);
                newItem.appendChild(endTimeText);

                return newItem;
            }

            /**
            * 添加一個新的項目到播放列表並更新顯示。
            */
            const addToPlaylist = () => {
                const newItem = createPlaylistItem();
                playlistState.playlistItems.push(newItem);
                ul.appendChild(newItem);
                playlistContainer.appendChild(ul);
                playlistState.state = getandUpdatePlaylistState(playlistState);
            }
            // 監聽添加到播放列表按鈕的點擊事件
            addToPlaylistButton.addEventListener('click', addToPlaylist);



        }

        test(sidebarElm);
    }

})();

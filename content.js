'use strict';
(async () => {
    console.log('yt-paj content.js injected');

    // 定義拖動項目和播放列表項目
    //let dragItem;
    //let dragImage;
    //let playlistItems = [];
    //let state = [];

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


    let dataClassModule;
    let playlistToolModule;
    try {
        dataClassModule = await import('./lib/dataclass.js');
        playlistToolModule = await import('./lib/playlistTool.js');
    }
    catch (error) {
        console.error('Module loading failed:', error);
    }
    const TimeSlot = dataClassModule.TimeSlot;
    const PlaylistItem = dataClassModule.PlaylistItem;
    const PlaylistState = dataClassModule.PlaylistState;
    const PlaylistCheckTool = playlistToolModule.PlaylistCheckTool;
    const PlaylistTimeManager = playlistToolModule.PlaylistTimeManager;

    const playlistState = new PlaylistState();

    class MouseEventHandler extends PlaylistCheckTool{
        /**
        * Create a playlist item.
        * @param {HTMLElement} playlistContainer - The container element for the playlist.
        * @param {PlaylistState} sharedState - The shared state object.
        */
        constructor(ul, playlistContainer, sharedState) {
            super(playlistContainer, sharedState);
            this.playlistContainer = playlistContainer;
            this.sharedState = sharedState;
            this.dragItem = null;
            this.dragImage = null;
            this.ul = ul;
            this.waitCount = 3;
            // 其他需要的初始化代碼...
        }

        createDragImage = (dragItem, event) => {
            const computedStyle = window.getComputedStyle(dragItem);
            const computedWidth = computedStyle.width;
            const computedHeight = computedStyle.height;

            const dragImage = dragItem.cloneNode(true);
            const dragHandle = dragImage.querySelector('.drag-handle');


            dragItem.removeEventListener('dragstart', this.handleDragStart);
            dragHandle.classList.remove('drag-handle');
            dragHandle.classList.add('drag-handle-clicked');
            dragImage.classList.remove('ytj-playlist-item');
            dragImage.classList.add('display-dragging');
            //handler偏移量
            dragImage.style.position = 'absolute';
            dragImage.style.top = `-${16}px`;
            dragImage.style.left = `-${16}px`;
            dragImage.style.width = computedWidth;
            dragImage.style.height = computedHeight;
            dragImage.style.zIndex = 1000;
            //先隱藏避免出現在畫面上
            dragImage.style.opcity = 0;

            return dragImage;
        };

        // 定義獲取拖放位置的函數
        getDragCrossElement = (ul, querySelector, y) => {
            const draggableElements = [...ul.querySelectorAll(querySelector)];

            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height * (1 / 2);

                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        };

        /**
        * 初始化拖曳過程。
        * @param {HTMLElement} item - 要拖曳的播放列表項目。
        * @param {MouseEvent} event - 觸發拖曳的事件對象。
        */
        handleDragStart = (event) => {
            const dragHandle = event.target.closest('.drag-handle');
            if (!dragHandle) return;

            const playlistItem = dragHandle.closest('.ytj-playlist-item');
            // 避免對非 playlist-item 元素進行操作
            if (!playlistItem) {
                return;
            }
            event.preventDefault();

            this.dragItem = playlistItem; // 設置拖動項目的參考
            // 創建拖曳縮略圖元素
            this.dragImage = this.createDragImage(this.dragItem, event);
            document.body.appendChild(this.dragImage);

            // 設置拖曳縮略圖的位置 恢復顯示 以及綁定事件
            this.dragImage.style.opcity = 1;
            this.dragImage.style.transform = `translateX(${event.pageX}px) translateY(${event.pageY}px)`;
            this.dragItem.classList.add('dragging');
            document.body.style.cursor = 'grabbing';

            // 添加移動和放開的事件監聽器
            document.addEventListener('mousemove', this.handleDragging);
            document.addEventListener('mouseup', this.handleDragEnd);
        };

        /**
         * 處理拖動過程中的事件。
         * @param {MouseEvent} event - 觸發拖動事件的事件對象。
         */
        handleDragging = (event) => {
            if (!this.dragImage) {
                console.error('拖曳圖像未找到。');
                return;
            }


            requestAnimationFrame(() => {
                if (!this.dragImage.style) {
                    return;
                }
                //1000是為了移出畫面的偏移量
                this.dragImage.style.transform = `translateX(${event.pageX}px) translateY(${event.pageY}px)`;


                // 更新拖曳縮略圖的位置

                this.waitCount--;
                if (this.waitCount > 0) {
                    return;
                }
                this.waitCount = 3;

                const movingY = event.clientY;
                const crossElement = this.getDragCrossElement(this.ul, '.ytj-playlist-item:not(.dragging)', movingY);

                // 進行 DOM 操作前確保有改變再操作，避免不必要的性能消耗
                if (crossElement == null) {
                    this.ul.appendChild(this.dragItem);
                } else {
                    if (this.dragItem.nextElementSibling !== crossElement) {
                        this.ul.insertBefore(this.dragItem, crossElement);
                    }
                }
            });

        };

        // 定義處理拖動結束的函數
        handleDragEnd = () => {
            // 移除滑鼠事件的監聽器
            document.removeEventListener('mousemove', this.handleDragging);
            document.removeEventListener('mouseup', this.handleDragEnd);

            if (this.dragImage) {
                this.dragImage.remove(); // 移除拖曳縮略圖
                this.dragImage = null;
            }

            this.dragItem.classList.remove('dragging');
            document.body.style.cursor = 'default';
            this.dragItem = null; // 清除拖動項目的參考
            this.sharedState.playlistItems = Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item'));
            this.sharedState.state = this.getandUpdatePlaylistState(); // 更新播放列表狀態
        }

    }

    const playlistCheckTool = new PlaylistCheckTool(playlistContainer, playlistState);
    const mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
    const playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);

    /**
     * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
     * @returns {?{hours: number, minutes: number, seconds: number, allseconds: number}} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
     */
    const getCurrentVideoTime = () => {
        const video = document.querySelector('video');
        if (!video) return null;

        const unparsedseconds = Math.floor(video.currentTime);
        const hours = Math.floor(unparsedseconds / 3600);
        const minutes = Math.floor((unparsedseconds % 3600) / 60);
        const seconds = unparsedseconds % 60;

        return { hours, minutes, seconds, allseconds: unparsedseconds };
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
        itemText.innerText = playlistTimeManager.formatTime(timeObj);
        itemText.contentEditable = false;

        let originalText = itemText.innerText;

        // 定義事件處理函數來處理不同的用戶互動
        const enableEditMode = () => {
            itemText.contentEditable = true;
            itemText.focus();
        };

        const saveEdits = () => {
            itemText.contentEditable = false;
            playlistTimeManager.updateTimeText(itemText, originalText);
            originalText = itemText.innerText;
            playlistState.state = playlistCheckTool.getandUpdatePlaylistState();
        };

        const cancelEdits = () => {
            itemText.innerText = originalText;
            itemText.contentEditable = false;
        };

        // 事件監聽器
        itemText.addEventListener('click', enableEditMode);
        itemText.addEventListener('keydown', (event) => {
            //阻止事件冒泡被YT播放器捕捉
            event.stopPropagation();
            if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault(); // 只有在需要時阻止默認行為
                if (event.key === 'Enter') {
                    event.target.blur();
                } else if (event.key === 'Escape') {
                    event.target.blur();
                    cancelEdits();
                }
            }
        });
        itemText.addEventListener('keyup', (event) => {
            //阻止事件冒泡被YT播放器捕捉
            event.stopPropagation();
        });
        itemText.addEventListener('blur', saveEdits);

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
                const dragHandle = event.target.closest('.drag-handle');
                if (dragHandle) {
                    mouseEventHandler.handleDragStart(event);
                }
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
                dragHandle.classList.add('drag-handle');
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
                playlistState.state = playlistCheckTool.getandUpdatePlaylistState();
            }
            // 監聽添加到播放列表按鈕的點擊事件
            addToPlaylistButton.addEventListener('click', addToPlaylist);



        }

        test(sidebarElm);
    }

})();

console.log("yt-paj content.js injected");

function equalsCheck(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function getTime() {
    const video = document.querySelector('video');
    if (video) {
        const UnPraseSeconds = Math.floor(video.currentTime);
        const hours = Math.floor(UnPraseSeconds / 3600)
        const minutes = Math.floor((UnPraseSeconds - 3600 * hours) / 60);
        const seconds = UnPraseSeconds - 3600 * hours - 60 * minutes;
        const output = {
            hours: hours,
            minutes: minutes,
            seconds: seconds,
            allSeconds: UnPraseSeconds
        }
        return output;
    }
}

function formatTime(hours, minutes, seconds) {

    if(!Number(hours)) {hours = 0;};
    if(!Number(minutes)) {minutes = 0;};
    if(!Number(seconds)) {seconds = 0;};

    const output =  `${String(Number(hours)).padStart(2, "0")}` + ":" +
                    `${String(Number(minutes)).padStart(2, "0")}` + ":" +
                    `${String(Number(seconds)).padStart(2, "0")}`;

    return output;

}

function praseTimeAndCheck(inputString, originalText) {

    let [hours, minutes, seconds] = String(inputString).split(":");

    if(!Number(hours) | !Number(minutes) | !Number(seconds)) {
        let [hours, minutes, seconds] = String(originalText).split(":");
        return {
            "hours": hours,
            "minutes": minutes,
            "seconds": seconds
        };
    };

    return {
        "hours": hours,
        "minutes": minutes,
        "seconds": seconds
    };

}

//初始化並與background.js進行綁定
chrome.runtime.onMessage.addListener(async function (request, sender, sendResponse) {
    if (request.action === "startExtension") {
        console.log("receive startExtension");
        sendResponse({ appstart: "yt-paj start." });
        //尋找sidebar 並開始主程式
        const sidebarQuery = '#related.style-scope.ytd-watch-flexy';
        const sidebarElm = document.querySelector(sidebarQuery);
        main(sidebarElm);

    }
});


async function main(sidebarElm) {

    /*
    function jumper(sidebarElm) {

        const jumpContainer = document.createElement('div');
        jumpContainer.id = 'auto-jumper';
        jumpContainer.className = 'auto-jumper-css';
        jumpContainer.style.marginTop = '10px';
        jumpContainer.style.maxWidth = '500px';
        jumpContainer.style.display = 'flex';

        const jumpInputHour = document.createElement('input');
        jumpInputHour.type = 'text';
        jumpInputHour.placeholder = 'hour';
        jumpInputHour.style.marginRight = '5px';
        jumpInputHour.style.maxWidth = '100px';
        jumpContainer.appendChild(jumpInputHour);

        const jumpInputMin = document.createElement('input');
        jumpInputMin.type = 'text';
        jumpInputMin.placeholder = 'min';
        jumpInputMin.style.marginRight = '5px';
        jumpInputMin.style.maxWidth = '100px';
        jumpContainer.appendChild(jumpInputMin);

        const jumpInputSec = document.createElement('input');
        jumpInputSec.type = 'text';
        jumpInputSec.placeholder = 'sec';
        jumpInputSec.style.marginRight = '5px';
        jumpInputSec.style.maxWidth = '100px';
        jumpContainer.appendChild(jumpInputSec);

        const jumpButton = document.createElement('button');
        jumpButton.textContent = 'Jump';
        jumpContainer.appendChild(jumpButton);

        function buildContainer() {
            if (sidebarElm) {
                sidebarElm.insertBefore(jumpContainer, sidebarElm.firstChild);
            }

            jumpButton.addEventListener('click', function () {
                let hour = 0;
                let min = 0;
                let sec = 0;
                if (jumpInputHour.value) {
                    hour = Number(jumpInputHour.value);
                }
                if (jumpInputMin.value) {
                    min = Number(jumpInputMin.value);
                }
                if (jumpInputSec.value) {
                    sec = Number(jumpInputSec.value);
                }
                console.log(hour, min, sec);
                jumpToTime(hour, min, sec);
            });

            function jumpToTime(hour, min, sec) {
                const video = document.querySelector('video');
                if (video) {
                    const jumpSeconds = hour * 3600 + min * 60 + sec;
                    console.log(jumpSeconds)
                    video.currentTime = jumpSeconds;
                }
            }
        }

        if (!sidebarElm) {
            window.addEventListener('yt-navigate-finish', function () {
                buildContainer();
            });
        }
        else {
            buildContainer();
        }
    }

    jumper(sidebarElm);
    */

    async function test(sidebarElm) {
        //建立container
        const playlistContainer = document.createElement('div');
        playlistContainer.id = 'playlist-container';
        playlistContainer.className = 'playlist-container';
        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        const addToPlaylistButton = document.createElement('button');
        addToPlaylistButton.id = 'add-to-playlist';
        addToPlaylistButton.className = 'add-to-playlist';
        sidebarElm.insertBefore(addToPlaylistButton, sidebarElm.firstChild);

        let playlistItems = [];
        let dragItem;

        // 添加播放列表項目的函數
        function addToPlaylist() {
            const newItem = createPlaylistItem();
            playlistItems.push(newItem);
            renderPlaylist();
            logPlaylistState();
        }

        // 創建播放列表項目的函數
        function createPlaylistItem() {
            const newItem = document.createElement('li');
            newItem.classList.add('playlist-item');

            const dragHandle = document.createElement('div');
            dragHandle.classList.add('drag-handle');
            dragHandle.draggable = true;
            dragHandle.addEventListener('dragstart', handleDragStart);
            dragHandle.addEventListener('dragover', handleDragOver);
            dragHandle.addEventListener('dragend', handleDragEnd);

            const itemText = document.createElement('div');
            itemText.classList.add('playlist-item-text');
            let timeobj = getTime();
            itemText.innerText = formatTime(timeobj.hours, timeobj.minutes, timeobj.seconds);

            let originalText = itemText.innerText;

            itemText.addEventListener('click', () => {
                // 啟用編輯模式
                itemText.contentEditable = true;
                itemText.focus();
            });

            itemText.addEventListener('keydown', (event) => {
                // 阻止事件冒泡
                event.stopPropagation();

                // 在這裡處理按鍵事件
                if (event.key === 'Enter') {
                    // 保存編輯內容
                    itemText.contentEditable = false;
                    let timeobj = praseTimeAndCheck(itemText.innerText, originalText);
                    itemText.innerText = formatTime(timeobj.hours, timeobj.minutes, timeobj.seconds);
                    originalText = itemText.innerText;
                    logPlaylistState();
                }

            });

            itemText.addEventListener('keyup', (event) => {
                // 阻止事件冒泡
                event.stopPropagation();

                // 阻止按鍵事件的默認行為
                event.preventDefault();

                if (event.key === 'Escape') {
                    // 取消編輯
                    itemText.innerText = originalText; // originalText 是原始文本
                    itemText.contentEditable = false;
                }
            });

            itemText.addEventListener('blur', () => {
                // 自動保存修改的內容
                itemText.contentEditable = false;
                // 在這裡處理保存操作，例如更新數據或其他相關操作
                let timeobj = praseTimeAndCheck(itemText.innerText, originalText);
                    itemText.innerText = formatTime(timeobj.hours, timeobj.minutes, timeobj.seconds);
                originalText = itemText.innerText;
                logPlaylistState();
            });

            newItem.appendChild(dragHandle);
            newItem.appendChild(itemText);

            return newItem;
        }

        // 更新播放列表的函數
        function renderPlaylist() {
            playlistContainer.innerHTML = '';
            const ul = document.createElement('ul');
            ul.id = 'playlist-items';

            // Append items in the order of the playlistItems array
            playlistItems.forEach(item => ul.appendChild(item));
            playlistContainer.appendChild(ul);
        }

        // 拖放相關事件處理函數
        function handleDragStart(e) {
            dragItem = e.target.closest('.playlist-item'); // 找到最接近的包含整個項目的父元素
            e.dataTransfer.setData('text/plain', '');

            // 创建拖曳缩略图元素
            const dragImage = dragItem.cloneNode(true);
            dragImage.classList.add('display-dragging');
            dragImage.id = "display_node";
            // 创建一个临时的容器元素
            const tempContainer = document.createElement('div');
            tempContainer.appendChild(dragImage);

            // 将拖曳缩略图元素添加到临时容器中
            document.body.appendChild(tempContainer);

            e.dataTransfer.setDragImage(dragImage, 24, 24);
            dragItem.classList.add('dragging');
        }

        function handleDragOver(e) {
            e.preventDefault();

            const ul = playlistContainer.querySelector('ul');
            const afterElement = getDragAfterElement(ul, e.clientY);
            const draggable = document.querySelector('.dragging');

            if (afterElement == null) {
                ul.appendChild(draggable);
            } else {
                ul.insertBefore(draggable, afterElement);
            }

            // Update the playlistItems array based on the new order
            playlistItems = Array.from(ul.children);
        }

        function handleDragEnd(e) {
            e.preventDefault();
            const dragImage = document.querySelector('.display-dragging');
            if (dragImage) {
                dragImage.remove();
            }
            dragItem.classList.remove('dragging');
            logPlaylistState();
        }

        // 獲取拖放位置的函數
        function getDragAfterElement(ul, y) {
            const draggableElements = [...ul.querySelectorAll('.playlist-item:not(.dragging)')];

            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;

                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        // 輸出播放列表狀態至控制台
        var lastPlaylistState = [];
        function logPlaylistState() {
            const playlistState = playlistItems.map(item => item.querySelector('.playlist-item-text').innerText);
            if (equalsCheck(lastPlaylistState, playlistState)) {
                lastPlaylistState = playlistState;
                return;
            }
            console.log('Playlist State:', playlistState);
            lastPlaylistState = playlistState;
        }

        // 監聽添加到播放列表按鈕的點擊事件
        addToPlaylistButton.addEventListener('click', addToPlaylist);
    }

    test(sidebarElm);
}
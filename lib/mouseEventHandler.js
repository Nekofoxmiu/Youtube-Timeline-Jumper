import { getandUpdatePlaylistState } from './playlistTool.js';

export class MouseEventHandler {
    constructor(ul, playlistContainer, sharedState) {
      this.ul = ul;
      this.playlistContainer = playlistContainer;
      this.sharedState = sharedState;
      this.dragItem = null;
      this.dragImage = null;
      this.waitCountReset = 3;
      this.waitCount = this.waitCountReset;
    }
  
    createDragImage(dragItem) {
      const computedStyle = window.getComputedStyle(dragItem);
      const dragImage = dragItem.cloneNode(true);
      const dragHandle = dragImage.querySelector('.ytj-drag-handle');
      dragHandle.classList.replace('ytj-drag-handle', 'ytj-drag-handle-clicked');
      dragImage.classList.replace('ytj-playlist-item', 'ytj-display-dragging');
      Object.assign(dragImage.style, {
        position: 'absolute',
        top: '-16px',
        left: '-16px',
        width: computedStyle.width,
        height: computedStyle.height,
        zIndex: '1000',
        opacity: '0',
      });
      return dragImage;
    }
  
    handleDragStart(event) {
      const dragHandle = event.target.closest('.ytj-drag-handle');
      if (!dragHandle) return;
      const playlistItem = dragHandle.closest('.ytj-playlist-item');
      if (!playlistItem) return;
      event.preventDefault();
      this.initiateDrag(playlistItem, event);
    }
  
    initiateDrag(item, event) {
      this.dragItem = item;
      this.dragImage = this.createDragImage(item);
      document.body.appendChild(this.dragImage);
      this.updateDragImagePosition(event.pageX, event.pageY);
      item.classList.add('ytj-dragging');
      document.body.style.cursor = 'grabbing';
      document.addEventListener('mousemove', this.handleDragging.bind(this));
      document.addEventListener('mouseup', this.handleDragEnd.bind(this));
    }
  
    updateDragImagePosition(pageX, pageY) {
      if (this.dragImage) {
        this.dragImage.style.opacity = '1';
        this.dragImage.style.transform = `translate(${pageX}px, ${pageY}px)`;
      }
    }
  
    handleDragging(event) {
      // 立即更新拖曳影像位置（動畫部分）
      requestAnimationFrame(() => {
          this.updateDragImagePosition(event.pageX, event.pageY);
      });
  
      // 將 DOM 操作延遲到下一次可用時機（資料更新部分）
      if (--this.waitCount <= 0) {
          this.waitCount = this.waitCountReset;
          setTimeout(() => {
              const crossElement = this.getDragCrossElement('.ytj-playlist-item:not(.ytj-dragging)', event.clientY);
              if (crossElement && this.dragItem) { 
                  this.ul.insertBefore(this.dragItem, crossElement);
              } else if (!crossElement && this.dragItem) {
                  this.ul.appendChild(this.dragItem);
              }
          }, 0); // 使用 setTimeout(0) 確保資料更新在 UI 更新後處理
      }
  }
  
    
  
    getDragCrossElement(selector, y) {
      const draggableElements = [...this.ul.querySelectorAll(selector)];
      return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        } else {
          return closest;
        }
      }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
  
    handleDragEnd() {
      document.removeEventListener('mousemove', this.handleDragging);
      document.removeEventListener('mouseup', this.handleDragEnd);
      if (this.dragImage) {
        this.dragImage.remove();
      }
      this.finalizeDrag();
    }
  
    finalizeDrag() {
      if (this.dragItem) {
        this.dragItem.classList.remove('ytj-dragging');
      }
      document.body.style.cursor = 'default';
      this.dragItem = null;
      this.dragImage = null;
      this.waitCount = this.waitCountReset;
      this.updatePlaylistState();
    }
  
    updatePlaylistState() {
      this.sharedState.playlistItems = Array.from(this.ul.querySelectorAll('.ytj-playlist-item'));
      this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
    }
  }
  
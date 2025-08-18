export class PlaylistStateManager {
    constructor(videoId) {
        this.videoId = videoId;
        this.state = [];
        this.storageKey = `playlist_${videoId}`;
    }

    async load() {
        if (!this.videoId) return;
        const result = await chrome.storage.local.get(this.storageKey);
        this.state = Array.isArray(result[this.storageKey]) ? result[this.storageKey] : [];
        return this.state;
    }

    async save() {
        if (!this.videoId) return;
        await chrome.storage.local.set({ [this.storageKey]: this.state });
    }

    setState(state) {
        this.state = state;
    }

    getState() {
        return this.state;
    }

    addItem(item) {
        this.state.push(item);
    }

    updateItem(index, item) {
        this.state[index] = item;
    }

    removeItem(index) {
        this.state.splice(index, 1);
    }
}

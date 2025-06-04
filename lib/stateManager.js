export class PlaylistStateManager {
    constructor(videoId) {
        this.videoId = videoId;
        this.state = [];
    }

    async load() {
        if (!this.videoId) return;
        const result = await chrome.storage.local.get(this.videoId);
        this.state = Array.isArray(result[this.videoId]) ? result[this.videoId] : [];
        return this.state;
    }

    async save() {
        if (!this.videoId) return;
        await chrome.storage.local.set({ [this.videoId]: this.state });
    }

    async updateState(state) {
        this.state = state;
        await this.save();
    }

    setState(state) {
        this.state = state;
    }

    getState() {
        return this.state;
    }

    async addItem(item) {
        this.state.push(item);
        await this.save();
    }

    async updateItem(index, item) {
        this.state[index] = item;
        await this.save();
    }

    async removeItem(index) {
        this.state.splice(index, 1);
        await this.save();
    }
}

export class PlaylistStateManager {
    constructor(videoId) {
        this.videoId = videoId;
        this.state = [];
        this.storageKey = `playlist_${videoId}`;
        this.metaKey = `playlist_meta_${videoId}`;
    }

    async load() {
        if (!this.videoId) return;
        const result = await chrome.storage.local.get(this.storageKey);
        this.state = Array.isArray(result[this.storageKey]) ? result[this.storageKey] : [];
        // Check for item-level metadata (legacy) and migrate to meta store if present
        const legacyMetaCandidates = this.state
            .filter(it => it && typeof it === 'object' && (it.lastModified || it.uploadTime))
            .map(it => ({ lastModified: it.lastModified || null, uploadTime: it.uploadTime || null }));

        if (legacyMetaCandidates.length) {
            // compute consolidated meta
            const now = new Date().toISOString();
            const lmList = legacyMetaCandidates.map(m => m.lastModified).filter(Boolean).sort();
            const utList = legacyMetaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
            const newMeta = { lastModified: lmList.length ? lmList.slice(-1)[0] : now, uploadTime: utList.length ? utList[0] : now };

            // strip metadata from items
            this.state = this.state.map(it => {
                if (it && typeof it === 'object') {
                    const copy = { ...it };
                    delete copy.lastModified;
                    delete copy.uploadTime;
                    return copy;
                }
                return it;
            });

            // persist items and meta separately
            await chrome.storage.local.set({ [this.storageKey]: this.state, [this.metaKey]: newMeta });
        }

        // Ensure meta state is consistent with items
        const metaResult = await chrome.storage.local.get(this.metaKey);
        if (this.state.length === 0) {
            // no timeline items -> remove any existing meta
            if (metaResult[this.metaKey]) {
                await chrome.storage.local.remove(this.metaKey);
            }
        } else if (!metaResult[this.metaKey]) {
            // have items but missing meta -> create with current timestamp
            const now2 = new Date().toISOString();
            await chrome.storage.local.set({ [this.metaKey]: { lastModified: now2, uploadTime: now2 } });
        }

        return this.state;
    }

    async save() {
        if (!this.videoId) return;
        await chrome.storage.local.set({ [this.storageKey]: this.state });
    }

    // meta operations
    async loadMeta() {
        if (!this.videoId) return null;
        const res = await chrome.storage.local.get(this.metaKey);
        return res[this.metaKey] || null;
    }

    async saveMeta(meta) {
        if (!this.videoId) return;
        // if no items or no meta provided, remove existing meta entry
        if (!meta || !Array.isArray(this.state) || this.state.length === 0) {
            await chrome.storage.local.remove(this.metaKey);
            return;
        }
        await chrome.storage.local.set({ [this.metaKey]: meta });
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

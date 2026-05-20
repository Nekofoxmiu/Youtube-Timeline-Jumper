export class TimeSlot {
    constructor(hours, minutes, seconds) {
        this.hours = Math.max(0, Math.floor(Number(hours) || 0));
        this.minutes = Math.max(0, Math.floor(Number(minutes) || 0));
        this.seconds = roundTime(Number(seconds) || 0);
        this.standardization();
    }
    gethours() {
        return this.hours;
    }
    getminutes() {
        return this.minutes;
    }
    getseconds() {
        return this.seconds;
    }
    getTotalseconds() {
        return this.hours * 3600 + this.minutes * 60 + this.seconds;
    }
    sethours(hours) {
        this.hours = Math.max(0, Math.floor(Number(hours) || 0));
        this.standardization();
    }
    setminutes(minutes) {
        this.minutes = Math.max(0, Math.floor(Number(minutes) || 0));
        this.standardization();
    }
    setseconds(seconds) {
        this.seconds = roundTime(seconds);
        this.standardization();
    }
    setByTotalseconds(Totalseconds) {
        const total = roundTime(Totalseconds);
        this.hours = Math.floor(total / 3600);
        this.minutes = Math.floor(((total - (this.hours * 3600)) / 60));
        this.seconds = roundTime(total - (this.hours * 3600) - (this.minutes * 60));
    }
    toformatString() {
        return `${this.hours.toString().padStart(2, '0')}:${this.minutes.toString().padStart(2, '0')}:${formatSecondToken(this.seconds)}`;
    }
    toformatObject() {
        return { hours: this.hours, minutes: this.minutes, seconds: this.seconds };
    }
    standardization(originalTimeObj) {
        if (!originalTimeObj) {
            originalTimeObj = { hours: 0, minutes: 0, seconds: 0 };
        }
        if (this.seconds >= 60) {
            this.minutes += Math.floor(this.seconds / 60);
            this.seconds = roundTime(this.seconds % 60);
        }
        if (this.minutes >= 60) {
            this.hours += Math.floor(this.minutes / 60);
            this.minutes %= 60;
        }
        const isValidTime = this.hours >= 0 && this.minutes >= 0 && this.seconds >= 0 && this.minutes < 60 && this.seconds < 60;
        if (!isValidTime) {
            this.hours = Math.max(0, Math.floor(Number(originalTimeObj.hours) || 0));
            this.minutes = Math.max(0, Math.floor(Number(originalTimeObj.minutes) || 0));
            this.seconds = roundTime(Number(originalTimeObj.seconds) || 0);
        }
        return this;
    }
    static fromObject(obj) {
        return new TimeSlot(obj?.hours, obj?.minutes, obj?.seconds);
    }


    static fromString(timeString) {
        const parts = String(timeString || '').split(':').reverse();
        const seconds = parseFloat(parts[0]) || 0;
        const minutes = parseInt(parts[1], 10) || 0;
        const hours = parseInt(parts[2], 10) || 0;
        return TimeSlot.fromTotalseconds(hours * 3600 + minutes * 60 + seconds);
    }
    static fromTotalseconds(Totalseconds) {
        const total = roundTime(Totalseconds);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total - (hours * 3600)) / 60);
        const seconds = roundTime(total - (hours * 3600) - (minutes * 60));
        return new TimeSlot(hours, minutes, seconds);
    }
}

function roundTime(value, digits = 3) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const factor = 10 ** digits;
    return Math.round(Math.max(0, num) * factor) / factor;
}

function formatSecondToken(seconds) {
    const sec = roundTime(seconds);
    const whole = Math.floor(sec);
    const fraction = sec - whole;
    if (fraction <= 1e-6) return String(whole).padStart(2, '0');
    return `${String(whole).padStart(2, '0')}${fraction.toFixed(3).slice(1).replace(/0+$/, '')}`;
}

export class PlaylistItem {
    constructor(start, end, title = '') {
        this.start = new TimeSlot(start.hours, start.minutes, start.seconds);
        this.end = new TimeSlot(end.hours, end.minutes, end.seconds);
        this.title = title;
    }
    getStartTimeObj() {
        return this.start;
    }
    getEndTimeObj() {
        return this.end;
    }
    setStartTimeObj(start) {
        this.start = start;
    }
    setEndTimeObj(end) {
        this.end = end;
    }
    getStartTimeString() {
        return this.start.toformatString();
    }
    getEndTimeString() {
        return this.end.toformatString();
    }
    setStartTimeByString(start) {
        this.start = TimeSlot.fromString(start);
    }
    setEndTimeByString(end) {
        this.end = TimeSlot.fromString(end);
    }
    getTitle() {
        return this.title;
    }
    setTitle(title) {
        this.title = title;
    }
    toString() {
        return `${this.getStartTimeString()} ~ ${this.getEndTimeString()} (Title: ${this.title})`;
    }
    toObject() {
        return { start: this.start, end: this.end, title: this.title };
    }
    static fromObject(obj) {
        return new PlaylistItem(obj.start, obj.end, obj.title);
    }
}

export class PlaylistState {
    constructor() {
        this.playlistItems = [];
        this.state = [];
    }

    getPlaylistItems() {
        return this.playlistItems;
    }

    getState() {
        return this.state;
    }

    setPlaylistItems(items) {
        this.playlistItems = items;
    }

    setState(state) {
        this.state = state;
    }

    addPlaylistItem(item) {
        this.playlistItems.push(item);
    }

    removePlaylistItem(index) {
        this.playlistItems.splice(index, 1);
    }

    clearPlaylistItems() {
        this.playlistItems = [];
    }

    clearState() {
        this.state = [];
    }

    clearAll() {
        this.clearPlaylistItems();
        this.clearState();
    }

    getPlaylistItem(index) {
        return this.playlistItems[index];
    }

    updatePlaylistItem(index, item) {
        this.playlistItems[index] = item;
    }

    getPlaylistItemLength() {
        return this.playlistItems.length;
    }

    getPlaylistState() {
        return this.state;
    }

    setPlaylistState(state) {
        this.state = state;
    }

    addPlaylistState(item) {
        this.state.push(item);
    }

    removePlaylistState(index) {
        this.state.splice(index, 1);
    }

    clearPlaylistState() {
        this.state = [];
    }

    getPlaylistStateItem(index) {
        return this.state[index];
    }

    updatePlaylistStateItem(index, item) {
        this.state[index] = item;
    }

    getPlaylistStateLength() {
        return this.state.length;
    }

    toString() {
        return this.playlistItems.map((item, index) => {
            return `Item ${index + 1}: ${item.toString()}`;
        }).join('\n');
    }

    toObject() {
        return { playlistItems: this.playlistItems, state: this.state };
    }
}

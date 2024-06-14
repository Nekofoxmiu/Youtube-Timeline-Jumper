export class TimeSlot {
    constructor(hours, minutes, seconds) {
        this.hours = hours;
        this.minutes = minutes;
        this.seconds = seconds;
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
        this.hours = hours;
    }
    setminutes(minutes) {
        this.minutes = minutes;
    }
    setseconds(seconds) {
        this.seconds = seconds;
    }
    setByTotalseconds(Totalseconds) {
        this.hours = Math.floor(Totalseconds / 3600);
        this.minutes = Math.floor((Totalseconds % 3600) / 60);
        this.seconds = Totalseconds % 60;
    }
    toformatString() {
        return `${this.hours.toString().padStart(2, '0')}:${this.minutes.toString().padStart(2, '0')}:${this.seconds.toString().padStart(2, '0')}`;
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
            this.seconds %= 60;
        }
        if (this.minutes >= 60) {
            this.hours += Math.floor(this.minutes / 60);
            this.minutes %= 60;
        }
        const isValidTime = this.hours >= 0 && this.minutes >= 0 && this.seconds >= 0 && this.minutes < 60 && this.seconds < 60;
        if (!isValidTime) {
            this.hours = originalTimeObj.hours;
            this.minutes = originalTimeObj.minutes;
            this.seconds = originalTimeObj.seconds;
        }
        return this;
    }
    static fromObject(obj) {
        return new TimeSlot(obj.hours, obj.minutes, obj.seconds);
    }
    static fromString(timeString) {
        const [hours, minutes, seconds] = timeString.split(':').map((num) => {
            const parsedNum = Number(num);
            return Number.isNaN(parsedNum) ? 0 : parsedNum;
        });
        return new TimeSlot(hours, minutes, seconds);
    }
    static fromTotalseconds(Totalseconds) {
        return new TimeSlot(Math.floor(Totalseconds / 3600), Math.floor((Totalseconds % 3600) / 60), Totalseconds % 60);
    }
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

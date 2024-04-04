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
        if(!originalTimeObj)
        {
            originalTimeObj = {hours: 0, minutes: 0, seconds: 0};
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
        if(!isValidTime)
        {
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
    constructor(start, end) {
        this.start = new TimeSlot(start.hours, start.minutes, start.seconds);
        this.end = new TimeSlot(end.hours, end.minutes, end.seconds);
    }
    /**
    * 解析時間字符串為時間物件。
    * @param {string} timeString - 格式為 "HH:MM:SS" 的時間字符串。
    * @returns {{hours: number, minutes: number, seconds: number}} - 包含小時、分鐘和秒的時間物件。
    */
    parseTime(timeString) {
        if (typeof timeString !== 'string') {
            throw new Error('Input must be a string');
        }
        const [hours, minutes, seconds] = timeString.split(':').map((num) => {
            const parsedNum = Number(num);
            return Number.isNaN(parsedNum) ? 0 : parsedNum;
        });
        return { hours, minutes, seconds };
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
        return this.start.hours + ":" + this.start.minutes + ":" + this.start.seconds;
    }
    getEndTimeString() {
        return this.end.hours + ":" + this.end.minutes + ":" + this.end.seconds;
    }
    setStartTimeByString(start) {
        this.start = this.parseTime(start);
    }
    setEndTimeByString(end) {
        this.end = this.parseTime(end);
    }
    toString() {
        return this.getStartTimeString() + " ~ " + this.getEndTimeString();
    }
    toObject() {
        return { start: this.start, end: this.end };
    }
    static fromObject(obj) {
        return new PlaylistItem(obj.start, obj.end);
    }
    static fromString(timeString) {
        const [start, end] = timeString.split('~').map((time) => {
            const parsedTime = this.parseTime(time);
            return parsedTime;
        });
        return new PlaylistItem(start, end);
    }
}

export class PlaylistState {
    constructor() {
        this.playlistItems = [];
        this.state = [];
        // 其他共享狀態...
    }
}
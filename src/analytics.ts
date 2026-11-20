export class AppAnalytics {
    private static _instance: AppAnalytics;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
    }

    public static Init() {
        // Strict offline mode: analytics disabled
    }

    public static Event(_id: string, _attributes?: unknown) {
        // Strict offline mode: analytics disabled
    }
}

export class ProviderError extends Error {
    detail;
    constructor(message, detail) {
        super(message);
        this.detail = detail;
        this.name = "ProviderError";
    }
}

export type ErrorCode =
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "VALHALLA_UNAVAILABLE"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ApplicationError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 500,
    public readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
    this.status = STATUS_BY_CODE[code];
  }
}

export function toSafeErrorResponse(
  error: unknown,
  requestId?: string,
): {
  status: number;
  body: { error: { code: ErrorCode; message: string; requestId?: string } };
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message, ...(requestId ? { requestId } : {}) },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}

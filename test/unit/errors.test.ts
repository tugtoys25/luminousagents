import { describe, expect, it } from 'vitest';
import { AppError, toSafeErrorResponse } from '../../src/lib/errors';

describe('safe error responses', () => {
  it('includes the request ID without exposing exception internals', () => {
    const response = toSafeErrorResponse(new Error('private database details'), 'request-123');
    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId: 'request-123',
    });
    expect(JSON.stringify(response)).not.toContain('private database details');
  });

  it('preserves known application errors with request correlation', () => {
    const response = toSafeErrorResponse(
      new AppError('BAD_REQUEST', 'Invalid request.'),
      'request-456',
    );
    expect(response.status).toBe(400);
    expect(response.body.error.requestId).toBe('request-456');
  });
});

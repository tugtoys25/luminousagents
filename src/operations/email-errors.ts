/** An email failure that retrying cannot fix (bad recipient, rejected sender, missing record). Jobs go straight to `dead`. */
export class PermanentEmailError extends Error {}
export type SendOptions = { from?: string | undefined; replyTo?: string | undefined };
export type SendEmailFn = (env: import('../env').Env, to: string | string[], subject: string, html: string, text: string, idempotencyKey?: string, options?: SendOptions) => Promise<void>;

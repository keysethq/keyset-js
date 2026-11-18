import type { BookingErrorCode, BookingProblem } from './types.js'

/**
 * What a caller may safely do next. This is the actionable part of a Keyset failure: the SDK never asks you to
 * guess whether repeating a request is safe.
 *
 * - `correct_input`     the request was rejected on its content. Fix it; repeating it unchanged cannot help.
 * - `retry_read`        a read did not complete. Repeat it; reads change nothing.
 * - `retry_same_request` repeat the identical request with the identical idempotency key. Never a fresh key.
 * - `search_again`      the world moved. Start from availability again with a new intent.
 * - `refresh_quote`     the price is stale. Create a new Quote and let the guest accept the current total.
 * - `refresh_cancellation_preview` read current cancellation terms and explicitly approve a new decision.
 * - `wait`              nothing to do yet; poll the checkout status.
 * - `contact_support`   no automated recovery is safe. A person has to look.
 */
export type BookingRecovery =
  | 'correct_input'
  | 'retry_read'
  | 'retry_same_request'
  | 'search_again'
  | 'refresh_quote'
  | 'refresh_cancellation_preview'
  | 'contact_support'
  | 'wait'

/**
 * Why a call did not produce a value.
 *
 * `outcome_unknown` is the one that matters most. It means the SDK cannot prove the mutation did not happen: the
 * request may have been applied and the answer lost. The only safe response is to repeat the identical request with
 * the identical idempotency key, or to read the authoritative state. Never start a new intent, and never issue a
 * second payment.
 */
export type BookingFailure =
  | {
      /** The request was refused locally and never dispatched, so nothing changed. */
      readonly kind: 'invalid_request'
      readonly recovery: 'correct_input'
      /** Which field failed, in dotted form, when the SDK could tell. */
      readonly path?: string
      readonly message: string
    }
  | {
      /** A mutation was dispatched and no usable answer came back. It may or may not have been applied. */
      readonly kind: 'outcome_unknown'
      readonly recovery: 'retry_same_request'
      readonly message: string
    }
  | {
      /** A read produced no usable answer: connection loss, abort, or a response the SDK could not validate. */
      readonly kind: 'transport'
      readonly recovery: 'retry_read'
      readonly message: string
    }
  | {
      /** Keyset answered with a problem document. `problem.code` is stable and safe to branch on. */
      readonly kind: 'api'
      readonly problem: BookingProblem
      readonly recovery: BookingRecovery
      /** The API request id, when the response carried one. Quote it in a support request. */
      readonly requestId?: string
    }

/**
 * Every SDK call returns a result instead of throwing. That is deliberate: a thrown error is easy to catch and retry
 * blindly, and blindly retrying a booking mutation whose outcome is unknown is exactly how a guest gets charged
 * twice. The discriminated union makes exhaustive handling available to a consumer; TypeScript does not require the
 * consumer to use that pattern automatically.
 */
export type BookingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BookingFailure }

/** True when the call produced a value. Narrows `result.value`. */
export function isOk<T>(result: BookingResult<T>): result is { readonly ok: true; readonly value: T } {
  return result.ok
}

/**
 * True when the mutation's outcome could not be established. Handle this before any other failure: it is the only
 * case where repeating the identical request is both necessary and safe.
 */
export function isUnknownOutcome<T>(result: BookingResult<T>): boolean {
  return !result.ok && result.error.kind === 'outcome_unknown'
}

/** A one-line, log-safe description of a failure. Carries no guest data and no secret. */
export function describeFailure(failure: BookingFailure): string {
  switch (failure.kind) {
    case 'api':
      return `${failure.problem.code} (${failure.problem.status}) -> ${failure.recovery}`
    case 'invalid_request':
      return `invalid_request${failure.path ? ` at ${failure.path}` : ''} -> correct_input`
    default:
      return `${failure.kind} -> ${failure.recovery}`
  }
}

/**
 * How a Keyset error code maps to the safe next step. For a code without a fixed mapping, `mutation` decides the
 * default, unless the server said repeating cannot succeed (`retryable: false`, since 0.12.1): then a person has to
 * look. A 503 „online booking is unavailable“ is such a case; offering the guest a retry there only fails again.
 */
export function recoveryFor(code: BookingErrorCode, mutation: boolean, retryable = true): BookingRecovery {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
    case 'PERMISSION_DENIED':
    case 'NOT_FOUND':
    case 'INVALID_REQUEST':
    case 'INVENTORY_CONFLICT':
      return 'correct_input'
    case 'VERSION_CONFLICT':
    case 'PREVIEW_STALE':
      return 'refresh_cancellation_preview'
    case 'POLICY_MISSING':
    case 'NOT_CANCELLABLE':
      return 'contact_support'
    case 'QUOTE_EXPIRED':
      return 'refresh_quote'
    case 'APARTMENT_NO_LONGER_AVAILABLE':
    case 'CHECKOUT_EXPIRED':
      return 'search_again'
    case 'INVALID_BOOKING_DETAILS':
      return 'correct_input'
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'BOOKING_NOT_AVAILABLE':
      return 'contact_support'
    case 'PAYMENT_SESSION_UNAVAILABLE':
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'wait'
    // The write may or may not have happened, and the key answers the same for a day: read the resource to find out.
    case 'IDEMPOTENCY_OUTCOME_UNKNOWN':
      return 'retry_read'
    default:
      if (!retryable) return 'contact_support'
      return mutation ? 'retry_same_request' : 'retry_read'
  }
}

export function invalidRequest(message: string, path?: string): BookingResult<never> {
  return {
    ok: false,
    error: { kind: 'invalid_request', recovery: 'correct_input', message, ...(path ? { path } : {}) },
  }
}

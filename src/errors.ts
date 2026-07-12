// A tiny, dependency-free typed error hierarchy for the Chitta SDK. Lets callers `catch`
// and branch on a stable `err.code` (or `instanceof ChittaError`) instead of string-matching
// human-readable messages.
//
// NOTE: permission / ACL failures are NOT modeled here — they already surface as the
// `AuthorizationError` thrown by `src/embedded/authorizer.ts` (write-side access control).

/** Base class for every error Chitta throws deliberately. Carries a stable, machine-readable `code`. */
export class ChittaError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "ChittaError"
  }
}

/** Invalid or unsupported SDK configuration (a bad `ChittaOptions`). */
export class ConfigError extends ChittaError {
  constructor(message: string) {
    super(message, "config")
    this.name = "ConfigError"
  }
}

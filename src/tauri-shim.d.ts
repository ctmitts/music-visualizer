/**
 * Types-only stand-in for `@tauri-apps/api`.
 *
 * `sources/tauri.ts` only ever runs inside the Tauri host app, where the real
 * package is installed. This declaration exists purely so the standalone
 * browser build type-checks without taking on the dependency.
 *
 * This file is intentionally NOT copied into the host app — it lives at the
 * `src/` root rather than inside `sources/`, and the host copies only
 * `core/`, `render/`, `sources/`, and `react/`. If it were copied it would
 * shadow the real typings.
 */
declare module "@tauri-apps/api/core" {
  export function invoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<T>;

  export class Channel<T = unknown> {
    constructor(onmessage?: (response: T) => void);
    set onmessage(handler: (response: T) => void);
    get onmessage(): (response: T) => void;
  }
}

/**
 * Passkeys with the WebAuthn PRF extension (ADR 0016). There is no server: the challenge is random
 * and never checked, because nothing is signed in to; what matters is the PRF output, which only the
 * authenticator can compute, after user verification, for this site's domain. The PRF output stays
 * in this page (keys.ts turns it into the seed and the vault key) and is never sent anywhere.
 */
import { b64url, prfInput, roleOf, unb64url, userHandle, type PasskeyRole } from "./keys";

export interface PasskeyResult {
  /** Credential id, base64url. */
  id: string;
  prf: Uint8Array;
  role?: PasskeyRole;
}

/**
 * Whether to offer a passkey first. True only when the browser reports PRF support (or cannot say)
 * and has a passkey authenticator at hand: a platform one (Face ID, Touch ID, Windows Hello, Android)
 * or a phone over hybrid transport, on a domain name. Headless browsers, machines without either and
 * pages served from an IP address get the passphrase vault. An authenticator that still turns out to lack PRF is caught after creation (createPasskey).
 */
export async function passkeyAvailable(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !window.isSecureContext || !window.PublicKeyCredential) return false;
    // A passkey is bound to a domain name: an IP address (http://127.0.0.1) cannot hold one.
    if (/^[\d.]+$|:/.test(location.hostname)) return false;
    const PKC = window.PublicKeyCredential as typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean>> };
    const caps = (await PKC.getClientCapabilities?.()) ?? {};
    if (caps["extension:prf"] === false) return false;
    if (caps.passkeyPlatformAuthenticator || caps.userVerifyingPlatformAuthenticator || caps.hybridTransport) return true;
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (cred: PublicKeyCredential): PrfResults | undefined => (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;
const bytes = (b: BufferSource) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

/** A passkey prompt the user closed, or one that failed, in one line. */
export function passkeyError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return new Error("No passkey used. Try again.");
  if (name === "InvalidStateError") return new Error("This passkey already opens this vault.");
  if (name === "SecurityError") return new Error("Passkeys need the app's own address (https).");
  return e instanceof Error ? e : new Error(String(e));
}

export class NoPrfError extends Error {
  constructor() {
    super("This passkey can't hold keys here. Use a passphrase.");
  }
}

/** Asks for a passkey and its PRF output. `allow` limits it to the vault's own passkeys. */
export async function getPasskey(allow?: string[]): Promise<PasskeyResult> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        userVerification: "required",
        allowCredentials: allow?.map((id) => ({ type: "public-key" as const, id: unb64url(id) })),
        extensions: { prf: { eval: { first: prfInput() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw passkeyError(e);
  }
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new NoPrfError();
  const handle = (cred.response as AuthenticatorAssertionResponse).userHandle;
  return { id: b64url(new Uint8Array(cred.rawId)), prf: bytes(first), role: roleOf(handle ? new Uint8Array(handle) : null) };
}

/**
 * Creates a passkey for this site and reads its PRF output. Some authenticators give the output at
 * creation; others only say PRF is enabled, and a second prompt (an assertion) reads it.
 */
export async function createPasskey(role: PasskeyRole, exclude: string[] = []): Promise<PasskeyResult> {
  const day = new Date().toISOString().slice(0, 10);
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Eclyps" },
        user: { id: userHandle(role), name: `Eclyps vault ${day}`, displayName: `Eclyps vault ${day}` },
        challenge: challenge(),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: exclude.map((id) => ({ type: "public-key" as const, id: unb64url(id) })),
        extensions: { prf: { eval: { first: prfInput() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw passkeyError(e);
  }
  const id = b64url(new Uint8Array(cred.rawId));
  const prf = prfOf(cred);
  if (prf?.results?.first) return { id, prf: bytes(prf.results.first), role };
  if (prf?.enabled === false || prf === undefined) throw new NoPrfError();
  const got = await getPasskey([id]);
  return { ...got, role };
}

// Minimal typing for the parts of circomlibjs used as an independent reference.
declare module "circomlibjs" {
  interface Poseidon {
    (inputs: bigint[]): Uint8Array;
    F: { toObject(x: Uint8Array): bigint };
  }
  export function buildPoseidon(): Promise<Poseidon>;
}

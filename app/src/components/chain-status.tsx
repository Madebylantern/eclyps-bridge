"use client";
import { useApp } from "@/lib/app";
import { hostOf } from "@/lib/deployment";
import { clock } from "@/lib/format";
import { describeChainError } from "@/lib/solana";
import { Act, DocsLink, Line, short } from "./ui";

/**
 * What stops the app from working normally, one short line each: the Solana RPC is unreachable,
 * the gateway is not fully deployed or sends to an unexpected portal, deposits are paused, or the
 * Aztec wallet failed to open. The details are in the title; the explanation is on Docs.
 */
export function ChainStatus() {
  const { dep, snap, snapError, refresh, aztec } = useApp();
  const out: React.ReactNode[] = [];
  const why = <DocsLink to="status" />;

  if (snapError) {
    const { kind } = describeChainError(snapError, dep);
    const raw = snapError instanceof Error ? snapError.message : String(snapError);
    out.push(
      <Line key="rpc" alert={!snap} testId="chain-error" title={kind === "other" ? raw.slice(0, 400) : `RPC: ${hostOf(dep.solana.rpc)}. Your notes are safe here.`}
        action={<Act small quiet onClick={refresh}>Try again</Act>}>
        {kind === "unreachable" ? (snap ? `Lost contact with Solana at ${clock(snap.updatedAt)}` : "Can’t reach Solana · retrying") : kind === "no-gateway" ? "No Eclyps gateway on this network" : "Reading Solana failed · retrying"}
      </Line>,
    );
  }

  const gw = snap?.gateway;
  if (gw?.portal === "missing") {
    out.push(<Line key="portal" testId="gateway-not-deployed" title="No Ethereum portal on this network. You can still plan." action={why}>Deposits aren’t possible yet</Line>);
  } else if (gw?.portal === "mismatch") {
    out.push(
      <Line key="portal" alert testId="portal-mismatch" title={`On chain ${short(gw.onChainPortal, 6)}, expected ${short(dep.l1.portal, 6)}. Claims still work.`} action={why}>
        Deposits blocked: unexpected portal
      </Line>,
    );
  }
  if (gw?.pausedUntil) {
    out.push(<Line key="pause" testId="deposits-paused" title="Claims and take-backs still work." action={why}>Deposits paused until {clock(gw.pausedUntil)}</Line>);
  }
  if (aztec.state === "failed") {
    out.push(
      <Line key="aztec" testId="aztec-failed" title={aztec.error} action={<Act small quiet testId="aztec-retry" onClick={aztec.openEmbedded}>Retry</Act>}>
        The Aztec wallet didn’t open
      </Line>,
    );
  }
  if (out.length === 0) return null;
  return <div className="flex flex-col gap-2">{out}</div>;
}

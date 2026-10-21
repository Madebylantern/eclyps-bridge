"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { useApp } from "@/lib/app";
import { VaultGate } from "./vault-gate";

/**
 * The vault step (ADR 0016, amended 2026-10-19: wallet first). It comes only when an action needs
 * the vault (Send, a claim, Move out, Keys, Balance once a vault exists): one centred step on black,
 * over the bridge, which waits paused beneath. Closing it (Close, Escape) cancels the action that
 * asked; opening the vault lets that action go on.
 */
export function VaultSheet() {
  const { dep, gate, openVault, cancelGate } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gate) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [gate]);
  return (
    <AnimatePresence>
      {gate && (
        <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Your keys" data-testid="vault-sheet"
          className="fixed inset-0 z-[60] overflow-y-auto bg-black outline-none"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <div className="mx-auto flex min-h-full w-full max-w-[72rem] flex-col px-[clamp(20px,5vw,64px)]">
            <VaultGate dep={dep} onReady={openVault} onCancel={cancelGate} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

"use client";
import { backupChallenge, checkBackupWords, MNEMONIC_WORDS } from "@eclyps/sdk";
import { useState } from "react";
import { Act, FieldLabel, Input, StatusLine } from "./ui";

/** Placeholder shapes shown (blurred) before reveal, so the words are not in the page until then. */
const HIDDEN = Array.from({ length: MNEMONIC_WORDS }, (_, i) => "•".repeat(4 + ((i * 7) % 5)));

/** The 24 words in a numbered mono grid, veiled until the user reveals them. */
export function PhraseGrid({ phrase, revealed, onReveal, testId = "seed-backup" }: { phrase: string; revealed: boolean; onReveal?: () => void; testId?: string }) {
  const words = revealed ? phrase.split(" ") : HIDDEN;
  return (
    <div className="relative">
      <ol data-testid={testId} data-revealed={revealed} className={`words ${revealed ? "" : "veiled"}`} aria-hidden={!revealed} aria-label={revealed ? "Recovery phrase" : undefined}>
        {words.map((w, i) => (
          <li key={i} className="min-w-0 truncate">
            <em className="tabular">{i + 1}</em>
            <span data-testid={revealed ? `seed-word-${i + 1}` : undefined}>{w}</span>
          </li>
        ))}
      </ol>
      {!revealed && onReveal && (
        <div className="absolute inset-0 grid place-items-center px-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <Act testId="seed-reveal" onClick={onReveal}>Reveal the phrase</Act>
            <p className="text-sm text-grey">Make sure nobody can see your screen.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Asks for 3 random words of the written phrase (`backupChallenge`) and checks them
 * (`checkBackupWords`). Tells the user which position is wrong.
 */
export function WordCheck({ seed, onDone, onLater, laterLabel = "Check later", testId = "backup-check" }: { seed: Uint8Array; onDone: () => void | Promise<void>; onLater?: () => void; laterLabel?: string; testId?: string }) {
  const [positions] = useState(() => backupChallenge(3));
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const check = async () => {
    const wrong = positions.filter((p) => !checkBackupWords(seed, [{ position: p, word: answers[p] ?? "" }]));
    if (wrong.length > 0) {
      setErr(
        wrong.length === 1
          ? `Word ${wrong[0]} doesn't match. Check its spelling.`
          : `Words ${wrong.join(" and ").replace(/ and (?=.* and )/g, ", ")} don't match. Check their spelling.`,
      );
      return;
    }
    setErr(undefined);
    setBusy(true);
    try {
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-6" data-testid={testId} onSubmit={(e) => { e.preventDefault(); check(); }}>
      <div className="grid gap-x-10 gap-y-5 sm:grid-cols-3">
        {positions.map((p) => (
          <label key={p} className="flex flex-col gap-1">
            <FieldLabel>Word {p}</FieldLabel>
            <Input testId={`backup-word-${p}`} data-position={p} value={answers[p] ?? ""} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="word"
              onChange={(e) => setAnswers((a) => ({ ...a, [p]: e.target.value }))} className="font-mono" />
          </label>
        ))}
      </div>
      <StatusLine error={err} testId="backup-check-error" />
      <div className="acts">
        <Act type="submit" arrow testId="backup-check-submit" disabled={busy || positions.some((p) => !(answers[p] ?? "").trim())}>Check</Act>
        {onLater && <Act quiet testId="backup-later" onClick={onLater}>{laterLabel}</Act>}
      </div>
    </form>
  );
}

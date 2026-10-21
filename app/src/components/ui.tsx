"use client";
import type { Advice } from "@eclyps/sdk";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/*
 * Primitives in the black-and-white language (globals.css): no boxes, no pills, no coloured states.
 * Hierarchy comes from size, weight and light; actions are words that glow when reached; lists use
 * a 1px hairline between rows; statuses are words, sometimes with a still dot.
 */

type DataAttrs = { [k: `data-${string}`]: string | number | boolean | undefined };

const EASE = [0.22, 1, 0.36, 1] as const;

/** A block of content that fades in. Separated from its neighbours by space alone. */
export function Section({ children, className = "", testId, label, ...data }: { children: ReactNode; className?: string; testId?: string; label?: string } & DataAttrs) {
  return (
    <motion.section data-testid={testId} aria-label={label} {...data} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }} className={className}>
      {children}
    </motion.section>
  );
}

/** An action: a word that brightens and glows on hover and keyboard focus. */
export function Act({
  children,
  onClick,
  disabled,
  quiet,
  big,
  small,
  arrow,
  testId,
  title,
  ariaLabel,
  pressed,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Grey until reached: secondary actions. */
  quiet?: boolean;
  big?: boolean;
  small?: boolean;
  /** A trailing arrow that nudges forward on hover. */
  arrow?: boolean;
  testId?: string;
  title?: string;
  ariaLabel?: string;
  pressed?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const cls = ["act", quiet && "quiet", big && "big", small && "small", className].filter(Boolean).join(" ");
  return (
    <button type={type} data-testid={testId} title={title} aria-label={ariaLabel} aria-pressed={pressed} onClick={onClick} disabled={disabled} className={cls}>
      {children}
      {arrow && <span className="arr" aria-hidden>→</span>}
    </button>
  );
}

/** Still status dot: done (white), now (white, faint halo), next (hollow). */
export function Glyph({ state, className = "" }: { state: "done" | "now" | "next"; className?: string }) {
  return <i className={`g ${state} ${className}`} aria-hidden />;
}

export function Label({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <span data-testid={testId} className={`label block ${className}`}>{children}</span>;
}

export function Mono({ children, className = "", testId, title }: { children: ReactNode; className?: string; testId?: string; title?: string }) {
  return <span data-testid={testId} title={title} className={`mono text-grey ${className}`}>{children}</span>;
}

export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/** A view's title: large, thin, white. */
export function Title({ children, className = "", testId, as: H = "h2" }: { children: ReactNode; className?: string; testId?: string; as?: "h1" | "h2" | "h3" }) {
  return <H data-testid={testId} className={`font-display text-[clamp(1.6rem,1.2rem+1.4vw,2.4rem)] font-extralight leading-[1.2] text-white ${className}`}>{children}</H>;
}

/** A section heading inside a view. */
export function Heading({ children, className = "", testId, as: H = "h2" }: { children: ReactNode; className?: string; testId?: string; as?: "h2" | "h3" }) {
  return <H data-testid={testId} className={`font-display text-[clamp(1.3rem,1.05rem+0.9vw,1.8rem)] font-extralight leading-[1.25] text-white ${className}`}>{children}</H>;
}

/** Plain text field: no box; a hairline shows under it while it has focus. */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { testId?: string }) {
  const { testId, className = "", ...rest } = props;
  return <input data-testid={testId} {...rest} className={`field ${className}`} />;
}

/** A small caption above a field. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="block text-sm text-grey">{children}</span>;
}

/** Native disclosure: a quiet word with a turning arrow. Works without JS, keyboard-accessible. */
export function Disclosure({ summary, children, testId, className = "" }: { summary: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <details className={`disclosure ${className}`}>
      <summary data-testid={testId}>
        {summary}
        <span className="arr" aria-hidden>→</span>
      </summary>
      <div className="mt-5">{children}</div>
    </details>
  );
}

/** One choice among a few, as words; the chosen one is white. */
export function Choice<T extends string>({ value, options, onChange, testId, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; testId?: string; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-7 gap-y-2" data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-testid={testId ? `${testId}-${o.value}` : undefined} onClick={() => onChange(o.value)}
          className={`nav-word !text-[0.9375rem] ${value === o.value ? "!text-white" : ""}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off as a word ("On", "Off"), not a sliding control. */
export function Switch({ on, onChange, label, testId, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId} disabled={disabled} onClick={() => onChange(!on)} className={`act small ${on ? "" : "quiet"}`}>
      {on ? "On" : "Off"}
    </button>
  );
}

/**
 * A full-screen black sheet with one centred column: no box, no border. Escape or Close dismisses
 * it. Focus moves into the sheet when it opens. `layer` stacks it (the wallet sheets open above the
 * vault step).
 */
export function Modal({ open, onClose, title, children, testId, layer = "z-50" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; testId?: string; layer?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
          className={`fixed inset-0 ${layer} overflow-y-auto bg-black outline-none`}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <div className="mx-auto flex min-h-full w-full max-w-[40rem] flex-col gap-10 px-5 pb-16 pt-8 sm:px-8 sm:pt-14">
            <div className="flex items-baseline justify-between gap-6">
              <Heading>{title}</Heading>
              <Act quiet small onClick={onClose} ariaLabel={`Close ${title}`}>Close</Act>
            </div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05, ease: EASE }}>
              {children}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A quiet "?" after a step's line: a word that glows when reached. It shows one short sentence
 * beneath the line (HelpText) and hides it on a second press or Escape. Escape is taken here first,
 * so it closes the sentence before it steps back or closes a sheet.
 */
export function HelpMark({ open, onToggle, testId = "help-toggle" }: { open: boolean; onToggle: () => void; testId?: string }) {
  const toggle = useRef(onToggle);
  useEffect(() => {
    toggle.current = onToggle;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      toggle.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <button type="button" className="help" data-testid={testId} aria-expanded={open} aria-label={open ? "Hide the explanation" : "What does this mean?"}
      title={open ? undefined : "What does this mean?"} onClick={onToggle}>
      ?
    </button>
  );
}

/** The sentence a "?" shows: plain text beneath its line, and where the rest is on Docs. */
export function HelpText({ children, docs, testId = "help-text" }: { children: ReactNode; docs?: DocsAnchor; testId?: string }) {
  return (
    <p className="help-text" data-testid={testId}>
      {children}
      {docs && <DocsLink to={docs} className="ml-3 !text-[length:inherit]">More in Docs</DocsLink>}
    </p>
  );
}

/** A step's line with its "?" and, once asked for, the one sentence beneath it. */
export function HelpLine({ children, help, docs, className = "", testId, helpTestId, center }: { children: ReactNode; help: ReactNode; docs?: DocsAnchor; className?: string; testId?: string; helpTestId?: string; center?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-col gap-1.5 ${center ? "items-center text-center" : "items-start"}`}>
      <p className={`text-balance ${className}`} data-testid={testId}>
        {children}
        <HelpMark open={open} onToggle={() => setOpen((o) => !o)} testId={helpTestId} />
      </p>
      {open && <HelpText docs={docs}>{help}</HelpText>}
    </div>
  );
}

/** Severity by typography alone: risk is white with "Risk", caution grey with "Caution", info dim. */
const SEVERITY = {
  risk: { word: "Risk", label: "text-white", title: "font-normal text-white" },
  caution: { word: "Caution", label: "text-grey", title: "text-text" },
  info: { word: "Note", label: "text-dim", title: "text-grey" },
} as const;

/** Sections of the Docs page (`/docs/`), where explanations, risks and limits live. */
export type DocsAnchor = "what" | "how" | "crowd" | "totality" | "public" | "limits" | "keys" | "fees" | "status" | "verify";

/** A quiet word that opens the Docs page at a section, in the same tab. */
export function DocsLink({ to, children = "Why", arrow, testId, className = "" }: { to?: DocsAnchor; children?: ReactNode; arrow?: boolean; testId?: string; className?: string }) {
  return (
    <a href={`/docs/${to ? `#${to}` : ""}`} data-testid={testId} className={`act quiet small ${className}`}>
      {children}
      {arrow && <span className="arr" aria-hidden>→</span>}
    </a>
  );
}

/**
 * Advisor output, one line per item: the severity word and the title. The longer explanation is
 * in the item's tooltip and on the Docs page (`why`), never a paragraph here. `empty` keeps the
 * list in the page, saying so, when there is nothing to flag.
 */
export function AdviceList({ items, testId = "advice", why, empty }: { items: Advice[]; testId?: string; why?: DocsAnchor; empty?: string }) {
  if (items.length === 0 && !empty) return null;
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      {items.length === 0 && <p className="text-sm text-dim">{empty}</p>}
      {items.map((a, i) => {
        const s = SEVERITY[a.severity];
        return (
          <motion.p key={a.id} data-severity={a.severity} title={a.detail} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.35 }}
            className="flex items-baseline gap-x-4">
            <span className={`label w-[4.75rem] shrink-0 ${s.label}`}>{s.word}</span>
            <span className={`min-w-0 ${s.title}`}>
              {a.title}
              {why && i === 0 && <DocsLink to={why} className="ml-4" />}
            </span>
          </motion.p>
        );
      })}
    </div>
  );
}

/** In-page confirmation that names the risk (no browser confirm()). */
export function Confirm({ title, body, confirmLabel, onConfirm, onCancel, testId, busy }: { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; testId?: string; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid={testId} role="alertdialog" aria-label={title}>
      <span className="label text-white">Are you sure</span>
      <p className="text-white">{title}</p>
      <div className="max-w-[56ch] text-sm text-grey">{body}</div>
      <div className="acts pt-1">
        <Act small onClick={onConfirm} disabled={busy} testId={testId ? `${testId}-confirm` : undefined}>{confirmLabel}</Act>
        <Act small quiet onClick={onCancel} testId={testId ? `${testId}-cancel` : undefined}>Cancel</Act>
      </div>
    </div>
  );
}

/** A line under an action: progress in grey, an error in white. */
export function StatusLine({ text, error, why, testId }: { text?: string; error?: string; why?: string; testId?: string }) {
  if (!text && !error) return null;
  return (
    <p data-testid={testId} role={error ? "alert" : "status"} title={error ? why : undefined} className={`max-w-[64ch] text-sm ${error ? "text-white" : "text-grey"}`}>
      {error ?? text}
    </p>
  );
}

/** Something that stops or changes normal use, said plainly: a caption, a sentence, an action. */
export function Notice({ label, title, children, action, testId, alert, className = "", ...data }: { label: string; title: ReactNode; children?: ReactNode; action?: ReactNode; testId?: string; alert?: boolean; className?: string } & DataAttrs) {
  return (
    <div role={alert ? "alert" : "status"} data-testid={testId} {...data} className={`grid gap-x-8 gap-y-1.5 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-baseline ${className}`}>
      <span className={`label ${alert ? "text-white" : ""}`}>{label}</span>
      <div className="min-w-0 space-y-1">
        <p className="text-white">{title}</p>
        {children && <div className="max-w-[68ch] text-sm text-grey">{children}</div>}
      </div>
      {action && <div className="pt-1 sm:pt-0">{action}</div>}
    </div>
  );
}

/**
 * One short line under the header for something that needs the user (a chain out of reach, the
 * Aztec wallet failed, an unchecked phrase): the words, then at most one action. The details sit in
 * the title and on Docs.
 */
export function Line({ children, action, testId, alert, title, ...data }: { children: ReactNode; action?: ReactNode; testId?: string; alert?: boolean; title?: string } & DataAttrs) {
  return (
    <p role={alert ? "alert" : "status"} data-testid={testId} title={title} {...data} className={`flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm ${alert ? "text-white" : "text-grey"}`}>
      <span>{children}</span>
      {action}
    </p>
  );
}

/** A public reference (signature, root, address) in mono, with a quiet Copy. */
export function Ref({ value, prefix, display, testId }: { value: string; prefix?: string; display?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard blocked: the value stays visible in the title. */
    }
  };
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3" data-testid={testId}>
      <span className="mono min-w-0 text-[0.75rem] text-grey [overflow-wrap:anywhere]" title={value}>
        {prefix && <span className="text-dim">{prefix} </span>}
        {display ?? short(value, 6)}
      </span>
      <button type="button" onClick={copy} aria-label={`Copy ${prefix ?? "reference"}`} className="act quiet !text-[0.75rem]">{copied ? "Copied" : "Copy"}</button>
    </span>
  );
}

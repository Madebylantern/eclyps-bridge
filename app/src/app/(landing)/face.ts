// The owner's typeface preview, invisible to visitors: face II (Marcellus SC, Roman inscription
// capitals) for the display lines only. `?face=2` turns it on and remembers it, `?face=1` turns it
// off, and T toggles it on the landing (remembered too), but only in a browser where ?face= has
// been used once, so a visitor pressing T by chance changes nothing. Inter stays the default;
// nothing on the page shows the switch.

const KEY = "eclyps.face";
const ARMED = "eclyps.face.armed";

function stored(): boolean {
  try { return localStorage.getItem(KEY) === "2"; } catch { return false; }
}
function store(on: boolean) {
  try { if (on) localStorage.setItem(KEY, "2"); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** True for T pressed on the page itself (not in a field, no modifier). */
export function isFaceKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "t" && e.key !== "T")) return false;
  const t = e.target as HTMLElement | null;
  return !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

export function mountFace(root: HTMLElement): () => void {
  let q: string | null = null;
  try { q = new URLSearchParams(location.search).get("face"); } catch { /* no search */ }
  let on = q === "2" ? true : q === "1" ? false : stored();
  if (q === "2" || q === "1") {
    store(on);
    try { localStorage.setItem(ARMED, "1"); } catch { /* private mode */ }
  }
  let armed = false;
  try { armed = localStorage.getItem(ARMED) === "1"; } catch { /* private mode */ }
  const apply = () => { if (on) root.dataset.face = "2"; else delete root.dataset.face; };
  apply();
  const onKey = (e: KeyboardEvent) => {
    if (!armed || e.repeat || !isFaceKey(e)) return;
    on = !on;
    store(on);
    apply();
  };
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("keydown", onKey);
    delete root.dataset.face;
  };
}

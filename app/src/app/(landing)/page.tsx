"use client";

import { useEffect, useRef } from "react";
import { Wordmark } from "@/components/wordmark";
import { mountFace } from "./face";
import { mountLanding } from "./scene";
import { mountSoundGate } from "./sound-gate";

// Markup of the approved landing. The scene script owns everything that moves (canvases, the
// classes that light the stations), so this component renders once and never updates.
export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  // The owner's typeface preview (face.ts): nothing on the page shows it.
  useEffect(() => (root.current ? mountFace(root.current) : undefined), []);
  useEffect(() => (root.current ? mountLanding(root.current) : undefined), []);
  // The splash is a cover: the page does not scroll until "Enter the darkness" is pressed; the
  // press wakes the eclipse, and "Scroll" comes once it has swelled (scene.ts). The sound
  // (sound-gate.ts, sound.ts) starts from that press or any first click, tap or key (or on load
  // where the browser already allows sound), never from scrolling. Turned off, it stays off for
  // those, but a press of "Enter the darkness" itself always starts it.
  useEffect(() => (root.current ? mountSoundGate(root.current) : undefined), []);

  return (
    <div ref={root}>
      <header className="hero" id="top">
        <canvas id="sky" aria-hidden="true"></canvas>
        <h1 className="wordmark" id="wordmark"><span className="wm-name">Eclyps</span><Wordmark /></h1>
        {/* On the cover the cue reads "Enter the darkness": a button laid exactly over "Scroll", which
            wakes the eclipse and starts the sound (even if it was turned off), then gives way to it. */}
        <button type="button" className="scroll-cue cue-enter" data-enter=""><span>Enter the darkness</span><i aria-hidden="true"></i></button>
        <a className="scroll-cue cue-scroll" href="#tagline" tabIndex={-1} aria-hidden="true" data-scroll=""><span>Scroll</span><i></i></a>
      </header>

      {/* The tagline's "Open the app", docked at the top once it scrolls up there (scene.ts). */}
      <a className="dock" href="/app/" data-dock="">Open the app <i aria-hidden="true">→</i></a>

      <main>
        <section className="tagline" id="tagline" aria-label="Tagline">
          <p className="bridge-line" data-emerge="view">The private bridge between Solana and Ethereum</p>
          <span data-emerge="view">Move freely.</span>
          <span className="second" data-emerge="lit">Remain unseen.</span>
          <a className="enter" href="/app/">Open the app <i aria-hidden="true">→</i></a>
        </section>

        {/* One screen that plays by itself on arrival (scene.ts): the notes travel at one even pace
            into the dark of the bridge and out onto Aztec, and each word lights as they reach it.
            Who holds the money and how to verify each stage are on Docs. */}
        <section className="story crossing" id="crossing" aria-labelledby="crossing-title">
          <div className="stage">
            <div className="stage-head">
              <span className="label">How money crosses</span>
              <h2 id="crossing-title" data-emerge="view">Three steps, two chains, one crossing you can verify.</h2>
            </div>
            <div className="scene">
              <canvas id="crossing-canvas" aria-hidden="true"></canvas>
              <ol className="stations">
                <li className="station" style={{ left: "15%" }}><b>Solana</b><small>Your USDC becomes fixed notes.</small></li>
                <li className="station" style={{ left: "50%" }}><b>Bridge</b><small>They cross together, unseen.</small></li>
                <li className="station" style={{ left: "85%" }}><b>Aztec</b><small>They land in your private balance.</small></li>
              </ol>
            </div>
            <a className="how" href="/docs/#how">How it works</a>
          </div>
        </section>

        {/* One screen too: the dots gather by themselves, then the first line, then the second. */}
        <section className="story crowd" id="crowd" aria-labelledby="crowd-title">
          <div className="stage">
            <div className="scene">
              <canvas id="crowd-canvas" aria-hidden="true"></canvas>
            </div>
            <div className="crowd-lines">
              <p id="crowd-title" data-emerge="play">Every note that crosses joins the crowd.</p>
              <p className="later" id="crowd-later" data-emerge="play">A claim proves it is one of them. Never which one.</p>
            </div>
          </div>
        </section>

        <section className="verify" aria-labelledby="verify-title">
          {/* The route as each network's own mark over its name, unaltered (docs/brand/third-party.md). */}
          <ol className="route" aria-label="The route">
            <li className="stop"><span className="mark"><img src="/brands/solana-logomark-white.svg" alt="" width={40} height={36} /></span><span data-emerge="view">Solana</span></li>
            <li className="leg" aria-hidden="true"></li>
            <li className="stop circle"><span className="mark"><img src="/brands/circle-icon-white.svg" alt="" width={32} height={32} /></span><span data-emerge="view">Circle CCTP</span></li>
            <li className="leg" aria-hidden="true"></li>
            <li className="stop eth"><span className="mark"><img src="/brands/ethereum-diamond-white.svg" alt="" width={40} height={40} /></span><span data-emerge="view">Ethereum</span></li>
            <li className="leg" aria-hidden="true"></li>
            <li className="stop aztec"><span className="mark"><img src="/brands/aztec-symbol-bw2.svg" alt="" width={54} height={54} /></span><span data-emerge="view">Aztec</span></li>
          </ol>
          <h2 id="verify-title" data-emerge="view">Verifiable at every step.</h2>
          <p>Every batch, and every dollar the bridge holds, can be checked on public chains. Which deposit became which balance stays private. The code is public.</p>
          <a className="go" href="/app/">Open the app <i aria-hidden="true">→</i></a>
        </section>
      </main>

      <footer>
        <span className="mark">ECLYPS</span>
        <nav className="foot-links" aria-label="Eclyps"><a href="/app/">App</a><a href="/docs/">Docs</a><button type="button" data-sound="">Sound on</button></nav>
        <p className="beta">Beta · It works end to end. Start with small notes while it is tested. <a href="/docs/#bounty">Bounty up to $5,000</a></p>
        <p>Nothing here is financial or legal advice</p>
      </footer>
    </div>
  );
}

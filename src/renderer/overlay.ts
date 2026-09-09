// The whole overlay renderer. It has no state of its own and no logic worth
// the name: whatever the main window pushed, it paints.

import type { OverlayState } from '../shared/types';

const strip = document.getElementById('strip') as HTMLElement;
const labelEl = document.getElementById('label') as HTMLElement;
const inEl = document.getElementById('in') as HTMLElement;

const EMPTY = '—';

function paint(state: OverlayState): void {
  const speaking = state.speaking?.trim() ?? '';

  if (speaking) {
    labelEl.textContent = speaking;
    inEl.textContent = '';
  } else {
    labelEl.textContent = state.nextLabel?.trim() || EMPTY;
    inEl.textContent = state.nextIn ?? '';
  }

  strip.classList.toggle('strip--muted', state.muted && !speaking);
  // re-adding the class restarts the flash, so back-to-back calls each get
  // their own blink instead of continuing the previous one mid-cycle
  if (speaking !== strip.dataset['speaking']) {
    strip.classList.remove('strip--speaking');
    if (speaking) {
      void strip.offsetWidth; // force a reflow so the animation actually restarts
      strip.classList.add('strip--speaking');
    }
    strip.dataset['speaking'] = speaking;
  }
}

window.overlay.onUpdate(paint);

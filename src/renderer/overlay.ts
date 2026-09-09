// The whole overlay renderer. It has no state of its own and no logic worth
// the name: whatever the main window pushed, it paints.

import type { OverlayItem, OverlayState } from '../shared/types';

const strip = document.getElementById('strip') as HTMLElement;
const speakingEl = document.getElementById('speaking') as HTMLElement;
const rowsEl = document.getElementById('rows') as HTMLElement;

function row(item: OverlayItem): HTMLElement {
  const el = document.createElement('div');
  el.className = 'row';
  // the soonest call is the one being read mid-fight; the rest are context
  if (item.priority >= 4) el.classList.add('row--urgent');

  const label = document.createElement('div');
  label.className = 'row__label';
  label.textContent = item.label;

  const time = document.createElement('div');
  time.className = 'row__in';
  time.textContent = item.in;

  el.append(label, time);
  return el;
}

function paint(state: OverlayState): void {
  const speaking = state.speaking?.trim() ?? '';

  rowsEl.replaceChildren(...state.items.map(row));
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'row row--empty';
    empty.textContent = '—';
    rowsEl.append(empty);
  }

  speakingEl.textContent = speaking;
  speakingEl.classList.toggle('strip__speaking--on', !!speaking);
  strip.classList.toggle('strip--muted', state.muted && !speaking);

  // re-adding the class restarts the flash, so back-to-back calls each get
  // their own blink instead of continuing the previous one mid-cycle
  if (speaking !== strip.dataset['speaking']) {
    speakingEl.classList.remove('strip__speaking--flash');
    if (speaking) {
      void speakingEl.offsetWidth; // force a reflow so the animation restarts
      speakingEl.classList.add('strip__speaking--flash');
    }
    strip.dataset['speaking'] = speaking;
  }
}

window.overlay.onUpdate(paint);

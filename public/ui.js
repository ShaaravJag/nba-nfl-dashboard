// Small shared UI helpers: the icon set and the motion that survives a
// re-render. Every view is rebuilt with innerHTML on each refresh, so a CSS
// transition never sees a "before" value on its own. snapshot() reads the
// values on screen, the view re-renders, and animate() plays the change.

/** An icon from the sprite in index.html. */
export const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const numberIn = (s) => parseFloat(String(s).replace(/[^\d.-]/g, ''));

/**
 * What's on screen now. [data-k] marks a number worth popping when it
 * changes; [data-w] marks an element whose inline style (a bar's width, a
 * knob's position) should glide to its new value.
 */
export function snapshot(root) {
  const nums = new Map();
  const styles = new Map();
  for (const n of root.querySelectorAll('[data-k]')) nums.set(n.dataset.k, n.textContent);
  for (const n of root.querySelectorAll('[data-w]')) styles.set(n.dataset.w, n.getAttribute('style') || '');
  return { nums, styles };
}

/** Play whatever changed between the snapshot and what was just rendered. */
export function animate(root, snap) {
  if (!snap || reduced()) return;
  // Put each moved bar back where it was, let the browser see that, then set
  // the new value: the element's own CSS transition does the rest.
  const moved = [];
  for (const n of root.querySelectorAll('[data-w]')) {
    const was = snap.styles.get(n.dataset.w);
    const now = n.getAttribute('style') || '';
    if (was != null && was !== now) { moved.push([n, now]); n.setAttribute('style', was); }
  }
  if (moved.length) {
    void root.offsetWidth;
    for (const [n, now] of moved) n.setAttribute('style', now);
  }
  for (const n of root.querySelectorAll('[data-k]')) {
    const was = snap.nums.get(n.dataset.k);
    if (was == null || was === n.textContent) continue;
    n.classList.add(numberIn(n.textContent) > numberIn(was) ? 'tick-up' : 'tick');
  }
}

/** A tab you just switched to rises in. Refreshes of the same tab don't. */
export function enter(view) {
  if (reduced()) return;
  view.classList.remove('enter');
  void view.offsetWidth;
  view.classList.add('enter');
  clearTimeout(view._enterT);
  view._enterT = setTimeout(() => view.classList.remove('enter'), 450);
}

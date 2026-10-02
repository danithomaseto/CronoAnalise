/* Tooltip dos gráficos SVG: marcas com data-tip mostram o texto ao passar o
   mouse, tocar ou focar pelo teclado. Um tooltip por área (host). */

export function bindTips(host) {
  let tip = null;
  const getTip = () => {
    if (!tip || !tip.isConnected) {
      tip = host.querySelector(':scope > .chart-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tip';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        host.appendChild(tip);
      }
    }
    return tip;
  };

  function position(e, el) {
    const t = getTip();
    const box = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = (e.clientX && e.type !== 'focusin' ? e.clientX : r.left + r.width / 2) - box.left;
    const y = (e.clientY && e.type !== 'focusin' ? e.clientY : r.top) - box.top;
    const w = t.offsetWidth || 160;
    t.style.left = Math.max(4, Math.min(box.width - w - 4, x - w / 2)) + 'px';
    t.style.top = Math.max(0, y - (t.offsetHeight || 28) - 12) + 'px';
  }

  function onIn(e) {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el || !host.contains(el)) return;
    const t = getTip();
    t.textContent = el.getAttribute('data-tip');
    t.hidden = false;
    el.classList.add('hover');
    const svg = el.ownerSVGElement;
    const cross = svg && svg.querySelector('.crosshair');
    if (cross && el.dataset.x) {
      cross.setAttribute('x1', el.dataset.x);
      cross.setAttribute('x2', el.dataset.x);
      cross.setAttribute('visibility', 'visible');
    }
    position(e, el);
  }

  function onMove(e) {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && host.contains(el)) position(e, el);
  }

  function onOut(e) {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    el.classList.remove('hover');
    getTip().hidden = true;
    const svg = el.ownerSVGElement;
    const cross = svg && svg.querySelector('.crosshair');
    if (cross) cross.setAttribute('visibility', 'hidden');
  }

  host.addEventListener('pointerover', onIn);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerout', onOut);
  host.addEventListener('focusin', onIn);
  host.addEventListener('focusout', onOut);
}

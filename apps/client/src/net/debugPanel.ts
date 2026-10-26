import type { DebugLink } from './debugLink';

/**
 * Sliders for the network simulator. Hidden unless the page URL has `?netdebug`, e.g.
 * http://localhost:5173/?netdebug . Moves ping, jitter and packet loss on a perfect connection so
 * prediction and lag compensation can be felt.
 */
export class DebugPanel {
  constructor(link: DebugLink) {
    if (!new URLSearchParams(location.search).has('netdebug')) return;
    document.getElementById('netdebug')?.remove();
    const box = document.createElement('div');
    box.id = 'netdebug';
    box.style.cssText = 'position:fixed;right:16px;bottom:140px;z-index:5;background:#000c;color:#e8eef4;padding:8px 10px;border:1px solid #fff4;font:12px system-ui,sans-serif;user-select:none';
    box.innerHTML = '<b>Network simulator</b><div id="nd-rows"></div><div style="opacity:.6">Esc / P first, then drag</div>';
    const rows = box.querySelector('#nd-rows') as HTMLElement;
    const state = { rtt: 0, jit: 0, loss: 0 };
    const add = (label: string, key: 'rtt' | 'jit' | 'loss', max: number, unit: string): void => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:4px';
      const out = document.createElement('span');
      out.style.cssText = 'width:4.5em;text-align:right';
      out.textContent = `0 ${unit}`;
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0'; inp.max = String(max); inp.value = '0';
      inp.addEventListener('input', () => {
        state[key] = Number(inp.value);
        out.textContent = `${inp.value} ${unit}`;
        link.setOptions(state.rtt, state.jit, state.loss);
      });
      row.append(`${label}`, inp, out);
      rows.appendChild(row);
    };
    add('Ping (RTT)', 'rtt', 400, 'ms');
    add('Jitter', 'jit', 100, 'ms');
    add('Loss', 'loss', 20, '%');
    document.body.appendChild(box);
  }
}

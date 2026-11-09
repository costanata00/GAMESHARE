// In-game overlay: who's talking right now, and a reminder when you're muted.
'use strict';
const list = document.getElementById('list');
const pills = new Map();

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function pill(key, make) {
  let p = pills.get(key);
  if (!p) { p = make(); pills.set(key, p); }
  return p;
}

window.overlay.onState((s) => {
  document.body.className = s.corner || 'top left';
  const labels = s.labels || {}; // in the app's language
  const want = [];
  if (s.me && s.me.muted) {
    want.push(pill('!muted', () => {
      const d = document.createElement('div'); d.className = 'pill warn';
      d.innerHTML = '<span class="ic mic"></span><span class="nm"></span>'; return d;
    }));
    want[want.length - 1].querySelector('.nm').textContent = labels.muted || 'You’re muted';
  }
  if (s.me && s.me.deafened) {
    want.push(pill('!deaf', () => {
      const d = document.createElement('div'); d.className = 'pill warn';
      d.innerHTML = '<span class="ic deaf"></span><span class="nm"></span>'; return d;
    }));
    want[want.length - 1].querySelector('.nm').textContent = labels.deafened || 'Voices muted';
  }
  for (const t of s.talking || []) {
    const p = pill(t.key, () => {
      const d = document.createElement('div'); d.className = 'pill';
      const av = document.createElement('span'); av.className = 'av';
      const nm = document.createElement('span'); nm.className = 'nm';
      d.append(av, nm); return d;
    });
    p.style.setProperty('--pc', t.color);
    p.querySelector('.av').textContent = initials(t.name);
    p.querySelector('.nm').textContent = t.name;
    want.push(p);
  }
  const keep = new Set(want);
  for (const [k, p] of pills) if (!keep.has(p)) { p.remove(); pills.delete(k); }
  want.forEach((p, i) => { if (list.children[i] !== p) list.insertBefore(p, list.children[i] || null); });
});

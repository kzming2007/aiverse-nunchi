'use strict';

// Four seats share the same socket geometry. Only the plunger and the striking arm travel.
const Flight = (() => {
  const folder = '/flight/';
  const cap = (name) => `<span class="switch-art" aria-hidden="true">
    <img class="socket" src="${folder}socket.webp" alt=""><img class="cap" src="${folder}cap-${name}.webp" alt="">
    <img class="lip" src="${folder}socket-front.webp" alt=""><i class="impact"></i></span>`;
  function bot(name) {
    const image = (role) => `<img class="figure ${role}" src="${folder}${name}-${role}.webp" draggable="false" alt="">`;
    const stroke = (layer) => `<span aria-hidden="true" class="figure stroke ${layer}" style="background-image:url('${folder}${name}-stroke.webp')"></span>`;
    return image('ready') + image('body') + image('result') + stroke('rear') + cap(name) + stroke('fingers');
  }

  // Use registered timestamps only. Consecutive collision partners share a spoken number.
  function calls(presses, windowMs) {
    const entries = Object.entries(presses).sort((a, b) => a[1] - b[1]);
    return entries.map(([id, t], i) => {
      let first = i;
      while (first && entries[first][1] - entries[first - 1][1] < windowMs) first--;
      const together = first < i || (i + 1 < entries.length && entries[i+1][1] - t < windowMs);
      return { id, number: first + 1, together };
    });
  }
  const animations = new Map();
  const shortMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function reset() {
    for (const fx of animations.values()) clearTimeout(fx);
    animations.clear();
    document.querySelectorAll('[data-strike],[data-together]').forEach(el => {
      delete el.dataset.strike;
      delete el.dataset.together;
    });
    document.getElementById('stage').dataset.phase = 'ready';
  }
  function pressed(id, presses, windowMs, name) {
    const stage = document.getElementById('stage');
    const el = document.getElementById('seat-' + id);
    const marks = calls(presses, windowMs);
    const mark = marks.find(x => x.id === id);
    for (const m of marks) {
      const seat = document.getElementById('seat-' + m.id);
      seat.querySelector('.callout').textContent = m.number + '!';
      if (m.together) seat.dataset.together = 'yes';
    }
    stage.dataset.phase = 'live';
    document.getElementById('big').textContent = mark.together ? '동시 입력' : name + '  ' + mark.number + '!';
    document.getElementById('sub').textContent = '';
    el.dataset.strike = 'yes';
    animations.set(id, setTimeout(() => { delete el.dataset.strike; animations.delete(id); }, shortMotion.matches ? 100 : 260));
    return mark.together;
  }
  return { cap, bot, calls, reset, pressed };
})();

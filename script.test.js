const fs = require('fs');
const path = require('path');

describe('interactive movement', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('mousemove updates transform', () => {
    const inter = document.createElement('div');
    inter.className = 'interactive';
    document.body.appendChild(inter);
    const grad = document.createElement('div');
    grad.className = 'gradients-container';
    document.body.appendChild(grad);

    jest.spyOn(document, 'querySelector').mockImplementation(sel => {
      if (sel === '.interactive') return inter;
      if (sel === '.gradients-container') return grad;
      return null;
    });

    // Load script.js
    require('./script.js');

    // Trigger DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // simulate mousemove
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 150 }));

    // run timers to process requestAnimationFrame
    jest.advanceTimersByTime(50);

    expect(inter.style.transform).not.toBe('');
  });

  test('scroll updates parallax transform', () => {
    const inter = document.createElement('div');
    inter.className = 'interactive';
    document.body.appendChild(inter);
    const grad = document.createElement('div');
    grad.className = 'gradients-container';
    document.body.appendChild(grad);

    jest.spyOn(document, 'querySelector').mockImplementation(sel => {
      if (sel === '.interactive') return inter;
      if (sel === '.gradients-container') return grad;
      return null;
    });

    require('./script.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    Object.defineProperty(window, 'scrollY', { value: 200, writable: true });
    window.dispatchEvent(new Event('scroll'));

    expect(grad.style.transform).toContain('translateY');
  });
});

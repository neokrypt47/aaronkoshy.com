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
    const div = document.createElement('div');
    div.className = 'interactive';
    document.body.appendChild(div);

    jest.spyOn(document, 'querySelector').mockReturnValue(div);

    // Load script.js
    require('./script.js');

    // Trigger DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // simulate mousemove
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 150 }));

    // run timers to process requestAnimationFrame
    jest.advanceTimersByTime(50);

    expect(div.style.transform).not.toBe('');
  });
});

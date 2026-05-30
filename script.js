document.addEventListener('DOMContentLoaded', () => {
  // Footer year
  const yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  // ── Custom cursor glow ──
  const glow = document.getElementById('cursor-glow');
  let glowX = 0, glowY = 0, targetX = 0, targetY = 0;
  let glowRaf;

  document.addEventListener('mousemove', e => {
    targetX = e.clientX;
    targetY = e.clientY;
  }, { passive: true });

  function animateGlow() {
    glowX += (targetX - glowX) * 0.1;
    glowY += (targetY - glowY) * 0.1;
    if (glow) glow.style.transform = `translate(${glowX - 170}px, ${glowY - 170}px)`;
    glowRaf = requestAnimationFrame(animateGlow);
  }
  animateGlow();

  document.addEventListener('mouseleave', () => { if (glow) glow.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { if (glow) glow.style.opacity = '1'; });

  // ── Nav toggle ──
  const toggle = document.querySelector('.nav-toggle');
  const menu = document.querySelector('.nav-menu');
  toggle?.addEventListener('click', () => {
    menu?.classList.toggle('open');
    const spans = toggle.querySelectorAll('span');
    spans[0].style.transform = menu?.classList.contains('open') ? 'rotate(45deg) translate(5px,5px)' : '';
    spans[1].style.opacity   = menu?.classList.contains('open') ? '0' : '1';
    spans[2].style.transform = menu?.classList.contains('open') ? 'rotate(-45deg) translate(5px,-5px)' : '';
  });
  menu?.querySelectorAll('.nav-link').forEach(l => l.addEventListener('click', () => menu.classList.remove('open')));

  // ── Scroll reveal ──
  const reveals = document.querySelectorAll('.reveal');
  const revealObs = new IntersectionObserver(entries => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('visible'), i * 60);
        revealObs.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  reveals.forEach(el => revealObs.observe(el));

  // ── Hero reveal immediately ──
  document.querySelectorAll('.hero .reveal').forEach((el, i) => {
    setTimeout(() => el.classList.add('visible'), 100 + i * 120);
  });

  // ── Project card 3D tilt ──
  document.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (rect.width / 2);
      const dy = (e.clientY - cy) / (rect.height / 2);
      card.style.transform = `translateY(-8px) scale(1.01) rotateX(${-dy * 4}deg) rotateY(${dx * 4}deg)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      card.style.transition = 'transform 0.6s cubic-bezier(0.23,1,0.32,1), border-color 0.3s, box-shadow 0.4s';
    });
    card.addEventListener('mouseenter', () => {
      card.style.transition = 'transform 0.15s ease, border-color 0.3s, box-shadow 0.4s';
    });
  });

  // ── Interactive gradient bubble ──
  const interBubble = document.querySelector('.interactive');
  const gradientsCont = document.querySelector('.gradients-container');
  if (!interBubble) return;

  let curX = 0, curY = 0, tgX = 0, tgY = 0;
  let isRunning = true, animId;

  function move() {
    if (!isRunning) return;
    curX += (tgX - curX) / 20;
    curY += (tgY - curY) / 20;
    interBubble.style.transform = `translate3d(${Math.round(curX)}px, ${Math.round(curY)}px, 0)`;
    animId = requestAnimationFrame(move);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { isRunning = false; cancelAnimationFrame(animId); }
    else { isRunning = true; move(); }
  });

  window.addEventListener('mousemove', e => { tgX = e.clientX; tgY = e.clientY; }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (e.touches.length > 0) { tgX = e.touches[0].clientX; tgY = e.touches[0].clientY; }
  }, { passive: true });
  window.addEventListener('scroll', () => {
    if (gradientsCont) gradientsCont.style.transform = `translate3d(0, ${window.scrollY * 0.08}px, 0)`;
  }, { passive: true });

  move();
});

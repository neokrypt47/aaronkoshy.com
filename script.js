document.addEventListener('DOMContentLoaded', () => {
    const interBubble = document.querySelector('.interactive');
    const gradients = document.querySelector('.gradients-container');

    if (!interBubble) return;

    let curX = 0;
    let curY = 0;
    let tgX = 0;
    let tgY = 0;
    let animationId = null;
    let isRunning = true;

    function move() {
        if (!isRunning) return;

        curX += (tgX - curX) / 20;
        curY += (tgY - curY) / 20;
        interBubble.style.transform = `translate3d(${Math.round(curX)}px, ${Math.round(curY)}px, 0)`;
        animationId = requestAnimationFrame(move);
    }

    function startAnimation() {
        if (!isRunning) {
            isRunning = true;
            move();
        }
    }

    function stopAnimation() {
        isRunning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    // Pause animation when tab is not visible
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopAnimation();
        } else {
            startAnimation();
        }
    });

    // Mouse movement handler
    window.addEventListener('mousemove', (event) => {
        tgX = event.clientX;
        tgY = event.clientY;
    }, { passive: true });

    // Touch movement handler for mobile
    window.addEventListener('touchmove', (event) => {
        if (event.touches.length > 0) {
            tgX = event.touches[0].clientX;
            tgY = event.touches[0].clientY;
        }
    }, { passive: true });

    // Scroll parallax handler
    window.addEventListener('scroll', () => {
        if (!gradients) return;
        const offset = window.scrollY * 0.1;
        gradients.style.transform = `translate3d(0, ${offset}px, 0)`;
    }, { passive: true });

    move();
});

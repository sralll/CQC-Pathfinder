(function () {
    const stage = document.querySelector('[data-home-infinity-logo]');
    if (!stage) return;

    const backCanvas = stage.querySelector('[data-depth-layer="back"]');
    const frontCanvas = stage.querySelector('[data-depth-layer="front"]');
    if (!backCanvas || !frontCanvas) return;

    const backCtx = backCanvas.getContext('2d', { alpha: true });
    const frontCtx = frontCanvas.getContext('2d', { alpha: true });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const TAU = Math.PI * 2;
    const LOGO = {
        width: 140.04231,
        height: 90.002087,
        cx: 70.02106,
        cy: 35.00001,
        ampX: 58.2,
        ampY: 43.0,
    };

    const colors = {
        warm: [255, 170, 86],
        pale: [255, 226, 174],
        pink: [255, 88, 210],
    };

    let metrics = {
        width: 0,
        height: 0,
        dpr: 1,
        scale: 1,
    };
    let particles = [];
    let animationId = 0;
    let lastTime = 0;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function smoothstep(edge0, edge1, value) {
        const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function mixRgb(a, b, t) {
        return [
            Math.round(lerp(a[0], b[0], t)),
            Math.round(lerp(a[1], b[1], t)),
            Math.round(lerp(a[2], b[2], t)),
        ];
    }

    function rgba(rgb, alpha) {
        return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    }

    function makeParticle(index, count) {
        return {
            t: (index / count + Math.random() * 0.045) % 1,
            speed: 0.010 + Math.random() * 0.008,
            lane: (Math.random() * 2 - 1),
            radius: 0.58 + Math.random() * 0.68,
            alpha: 0.48 + Math.random() * 0.34,
            phase: Math.random() * TAU,
        };
    }

    function syncParticles() {
        const desired = clamp(Math.round(metrics.width * 0.38), 96, 182);
        if (particles.length > desired) {
            particles = particles.slice(0, desired);
            return;
        }

        while (particles.length < desired) {
            particles.push(makeParticle(particles.length, desired));
        }
    }

    function fitCanvas(canvas, ctx) {
        canvas.width = Math.round(metrics.width * metrics.dpr);
        canvas.height = Math.round(metrics.height * metrics.dpr);
        ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    }

    function resize() {
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        metrics = {
            width: rect.width,
            height: rect.height,
            dpr: Math.min(window.devicePixelRatio || 1, 2),
            scale: Math.min(rect.width / LOGO.width, rect.height / LOGO.height),
        };

        fitCanvas(backCanvas, backCtx);
        fitCanvas(frontCanvas, frontCtx);
        syncParticles();
        render(performance.now(), false);
    }

    function logoToCanvas(point) {
        return {
            x: point.x * metrics.width / LOGO.width,
            y: point.y * metrics.height / LOGO.height,
        };
    }

    function pathPoint(particle, now) {
        const theta = particle.t * TAU;
        const sin = Math.sin(theta);
        const cos = Math.cos(theta);
        const x = LOGO.cx + LOGO.ampX * sin;
        const y = LOGO.cy + LOGO.ampY * sin * cos;
        const dx = LOGO.ampX * cos;
        const dy = LOGO.ampY * Math.cos(theta * 2);
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        const breath = Math.sin(now * 0.00042 + particle.phase) * 0.52;
        const curl = Math.sin(theta * 3.0 + now * 0.00058 + particle.phase) * 1.05
            + Math.sin(theta * 7.0 - now * 0.00026 + particle.phase * 0.7) * 0.42;
        const laneOffset = particle.lane * 2.25 + breath + curl;
        const driftX = Math.sin(theta * 2.0 - now * 0.00024 + particle.phase) * 0.32;
        const driftY = Math.cos(theta * 2.0 + now * 0.00028 + particle.phase) * 0.32;
        const z = Math.cos(theta - 0.16) + Math.sin(theta * 3.0 + particle.phase) * 0.12;

        return {
            x: x + nx * laneOffset + driftX,
            y: y + ny * laneOffset + driftY,
            z: clamp(z, -1, 1),
            theta: theta,
        };
    }

    function particleColor(point, particle, depth) {
        const qGlow = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(point.theta * 2 + particle.phase));
        const warmPink = mixRgb(colors.warm, colors.pink, qGlow);
        return mixRgb(warmPink, colors.pale, depth * 0.34);
    }

    function drawDot(ctx, canvasPoint, radius, alpha, rgb, glowScale) {
        if (alpha <= 0.01) return;

        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rgba(rgb, alpha * 0.18);
        ctx.beginPath();
        ctx.arc(canvasPoint.x, canvasPoint.y, radius * glowScale, 0, TAU);
        ctx.fill();

        ctx.fillStyle = rgba(rgb, alpha);
        ctx.beginPath();
        ctx.arc(canvasPoint.x, canvasPoint.y, radius, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    function clear() {
        backCtx.clearRect(0, 0, metrics.width, metrics.height);
        frontCtx.clearRect(0, 0, metrics.width, metrics.height);
    }

    function render(now, advance) {
        if (!metrics.width || !metrics.height) return;

        const dt = clamp((now - lastTime) / 1000 || 0, 0, 0.05);
        lastTime = now;
        clear();

        for (let i = 0; i < particles.length; i += 1) {
            const particle = particles[i];
            if (advance) {
                particle.t = (particle.t + particle.speed * dt) % 1;
            }

            const point = pathPoint(particle, now);
            const canvasPoint = logoToCanvas(point);
            const depth = (point.z + 1) * 0.5;
            const frontAmount = smoothstep(-0.08, 0.42, point.z);
            const backAmount = 1 - smoothstep(-0.36, 0.14, point.z);
            const shimmer = 0.9 + Math.sin(now * 0.001 + particle.phase) * 0.1;
            const baseRadius = particle.radius * metrics.scale * shimmer;
            const rgb = particleColor(point, particle, depth);

            drawDot(
                backCtx,
                canvasPoint,
                baseRadius * (0.78 + depth * 0.1),
                particle.alpha * backAmount * 0.58,
                rgb,
                3.2
            );

            drawDot(
                frontCtx,
                canvasPoint,
                baseRadius * (0.9 + depth * 0.32),
                particle.alpha * frontAmount,
                rgb,
                3.8
            );
        }
    }

    function tick(now) {
        render(now, true);
        animationId = window.requestAnimationFrame(tick);
    }

    function start() {
        if (animationId) {
            window.cancelAnimationFrame(animationId);
            animationId = 0;
        }

        lastTime = performance.now();
        render(lastTime, false);
        if (!reducedMotion.matches) {
            animationId = window.requestAnimationFrame(tick);
        }
    }

    if ('ResizeObserver' in window) {
        const observer = new ResizeObserver(resize);
        observer.observe(stage);
    } else {
        window.addEventListener('resize', resize);
    }

    if (typeof reducedMotion.addEventListener === 'function') {
        reducedMotion.addEventListener('change', start);
    } else if (typeof reducedMotion.addListener === 'function') {
        reducedMotion.addListener(start);
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden && animationId) {
            window.cancelAnimationFrame(animationId);
            animationId = 0;
        } else if (!document.hidden) {
            start();
        }
    });

    resize();
    start();
}());

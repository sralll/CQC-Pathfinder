(function () {
    const stage = document.querySelector('[data-home-infinity-logo]');
    if (!stage) return;

    const logo = stage.querySelector('.home-logo');
    if (!logo) return;

    const TAU = Math.PI * 2;
    const LOGO = {
        width: 140.04231,
        height: 90.002087,
        cx: 70.02106,
        cy: 35.00001,
        ampX: 46.5,
        ampY: 7.0,
    };
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const TRAIL_OFFSETS = [0.0520, 0.0440, 0.0360, 0.0280, 0.0205, 0.0135, 0.0070, 0];

    function applyLayerStyle(element, zIndex) {
        element.style.position = 'absolute';
        element.style.inset = '0';
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.display = 'block';
        element.style.pointerEvents = 'none';
        element.style.zIndex = String(zIndex);
    }

    function createCanvas(className, layer, zIndex) {
        const canvas = document.createElement('canvas');
        canvas.className = className;
        canvas.dataset.depthLayer = layer;
        canvas.setAttribute('aria-hidden', 'true');
        applyLayerStyle(canvas, zIndex);
        return canvas;
    }

    function createPath(className, d) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', className);
        path.setAttribute('d', d);
        return path;
    }

    function createOccluder() {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'home-logo-depth-occluder');
        svg.setAttribute('viewBox', '0 0 140.04231 90.002087');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        applyLayerStyle(svg, 4);
        svg.style.overflow = 'visible';

        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('transform', 'translate(-44.978842,-21.47607)');
        g.appendChild(createPath(
            'home-logo-depth-c',
            'm 150.00015,21.47621 a 34.999998,34.999998 0 0 0 -14.40738,3.125908 37.949999,37.949999 0 0 1 8.48113,7.597985 25,25 0 0 1 5.92625,-0.723987 25,25 0 0 1 24.99951,25.000023 25,25 0 0 1 -23.78821,24.968504 l 8.62066,8.620662 A 34.999998,34.999998 0 0 0 185.00009,56.476139 34.999998,34.999998 0 0 0 150.00015,21.47621 Z m -14.40067,66.84243 a 37.949999,37.949999 0 0 1 -0.03,0.02119 34.999998,34.999998 0 0 0 0.0873,0.03617 z'
        ));
        g.appendChild(createPath(
            'home-logo-depth-c',
            'm 79.999833,21.47607 a 34.999998,34.999998 0 0 0 -34.99993,34.99993 34.999998,34.999998 0 0 0 34.99993,34.99993 34.999998,34.999998 0 0 0 14.43065,-3.136243 37.949999,37.949999 0 0 1 -8.48682,-7.592301 25,25 0 0 1 -5.94383,0.728638 A 25,25 0 0 1 54.99981,56.476 25,25 0 0 1 79.999833,31.475976 a 25,25 0 0 1 5.95106,0.720368 37.949999,37.949999 0 0 1 8.49767,-7.595402 34.999998,34.999998 0 0 0 -14.44873,-3.124872 z'
        ));
        svg.appendChild(g);
        return svg;
    }

    function syncStageBox() {
        const parentRect = stage.parentElement.getBoundingClientRect();
        if (!parentRect.width) return;

        const mobileLayout = window.matchMedia('(max-width: 700px)').matches
            || document.body.classList.contains('mobile');
        const targetWidth = mobileLayout
            ? Math.min(parentRect.width, window.innerWidth * 0.82, 340)
            : parentRect.width;

        stage.style.position = 'relative';
        stage.style.width = targetWidth + 'px';
        stage.style.height = (targetWidth * LOGO.height / LOGO.width) + 'px';
        stage.style.aspectRatio = LOGO.width + ' / ' + LOGO.height;
        stage.style.isolation = 'isolate';
    }

    syncStageBox();

    stage.querySelectorAll('.home-infinity-canvas, .home-logo-depth-occluder').forEach(function (element) {
        element.remove();
    });

    const backCanvas = createCanvas(
        'home-infinity-canvas home-infinity-canvas-back',
        'back',
        1
    );
    const frontCanvas = createCanvas(
        'home-infinity-canvas home-infinity-canvas-front',
        'front',
        5
    );
    const occluder = createOccluder();

    stage.insertBefore(backCanvas, logo);
    stage.appendChild(frontCanvas);
    stage.appendChild(occluder);

    applyLayerStyle(logo, 2);
    logo.style.objectFit = 'contain';
    frontCanvas.style.mixBlendMode = 'normal';

    const backCtx = backCanvas.getContext('2d', { alpha: true });
    const frontCtx = frontCanvas.getContext('2d', { alpha: true });
    if (!backCtx || !frontCtx) return;

    stage.dataset.homeInfinityReady = 'true';

    const colors = {
        cGray: [204, 204, 204],
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

    function smoothstep(edge0, edge1, value) {
        const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function rgba(rgb, alpha) {
        return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    }

    function makeParticle(index, count) {
        return {
            t: (index / count + Math.random() * 0.045) % 1,
            speed: 0.0182 + Math.random() * 0.0126,
            lane: (Math.random() * 2 - 1),
            radius: 0.42 + Math.random() * 0.46,
            alpha: 0.72 + Math.random() * 0.22,
            phase: Math.random() * TAU,
        };
    }

    function syncParticles() {
        const desired = clamp(Math.round(metrics.width * 0.26), 72, 128);
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
        syncStageBox();

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

    function pathPoint(particle, now, tOverride) {
        const t = typeof tOverride === 'number' ? tOverride : particle.t;
        const theta = t * TAU;
        const sin = Math.sin(theta);
        const cos = Math.cos(theta);
        const x = LOGO.cx + LOGO.ampX * sin;
        const yWave = Math.sin(theta * 2);
        const y = LOGO.cy + LOGO.ampY * yWave;
        const dx = LOGO.ampX * cos;
        const dy = LOGO.ampY * 2 * Math.cos(theta * 2);
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        const breath = Math.sin(now * 0.0005 + particle.phase) * 0.24;
        const curl = Math.sin(theta * 4.0 + now * 0.0008 + particle.phase) * 0.28
            + Math.sin(theta * 8.0 - now * 0.00036 + particle.phase * 0.7) * 0.12;
        const laneOffset = particle.lane * 1.75 + breath + curl;
        const driftX = Math.sin(theta * 3.0 - now * 0.0003 + particle.phase) * 0.18;
        const driftY = Math.cos(theta * 2.0 + now * 0.00034 + particle.phase)
            * 0.08
            * Math.abs(yWave);
        const finalX = x + nx * laneOffset + driftX;
        const finalY = y + ny * laneOffset + driftY;
        const frontWindow = smoothstep(-0.26, 0.26, yWave);
        const z = -1 + frontWindow * 2 + yWave * 0.04 + Math.sin(theta * 3.0 + particle.phase) * 0.025;

        return {
            x: finalX,
            y: finalY,
            z: clamp(z, -1, 1),
            theta: theta,
        };
    }

    function particleColor() {
        return colors.cGray;
    }

    function drawDot(ctx, canvasPoint, radius, alpha, rgb) {
        if (alpha <= 0.01) return;

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba(rgb, alpha);
        ctx.beginPath();
        ctx.arc(canvasPoint.x, canvasPoint.y, radius, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    function drawLine(ctx, from, to, width, alpha, rgb) {
        if (alpha <= 0.01) return;

        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = rgba(rgb, alpha);
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
    }

    function clear() {
        backCtx.clearRect(0, 0, metrics.width, metrics.height);
        frontCtx.clearRect(0, 0, metrics.width, metrics.height);
    }

    function drawParticle(particle, now, t, alphaScale, radiusScale) {
        const point = pathPoint(particle, now, t);
        const canvasPoint = logoToCanvas(point);
        const depth = (point.z + 1) * 0.5;
        const frontAmount = smoothstep(-0.34, 0.66, point.z);
        const backAmount = 1 - smoothstep(-0.66, 0.34, point.z);
        const shimmer = 0.94 + Math.sin(now * 0.0014 + particle.phase) * 0.06;
        const baseRadius = particle.radius * metrics.scale * shimmer * radiusScale;
        const rgb = particleColor();

        drawDot(
            backCtx,
            canvasPoint,
            baseRadius * (0.66 + depth * 0.12),
            particle.alpha * alphaScale * backAmount * 0.42,
            rgb
        );

        drawDot(
            frontCtx,
            canvasPoint,
            baseRadius * (0.78 + depth * 0.36),
            particle.alpha * alphaScale * frontAmount * (0.66 + depth * 0.20),
            rgb
        );
    }

    function drawTrailSegment(particle, now, fromT, toT, midT, alphaScale) {
        const fromPoint = pathPoint(particle, now, fromT);
        const toPoint = pathPoint(particle, now, toT);
        const midPoint = pathPoint(particle, now, midT);
        const depth = (midPoint.z + 1) * 0.5;
        const frontAmount = smoothstep(-0.34, 0.66, midPoint.z);
        const backAmount = 1 - smoothstep(-0.66, 0.34, midPoint.z);
        const shimmer = 0.94 + Math.sin(now * 0.0014 + particle.phase) * 0.06;
        const baseRadius = particle.radius * metrics.scale * shimmer;
        const rgb = particleColor();
        const fromCanvas = logoToCanvas(fromPoint);
        const toCanvas = logoToCanvas(toPoint);

        drawLine(
            backCtx,
            fromCanvas,
            toCanvas,
            baseRadius * (0.66 + depth * 0.12) * 2,
            particle.alpha * alphaScale * backAmount * 0.16,
            rgb
        );

        drawLine(
            frontCtx,
            fromCanvas,
            toCanvas,
            baseRadius * (0.78 + depth * 0.36) * 2,
            particle.alpha * alphaScale * frontAmount * (0.26 + depth * 0.08),
            rgb
        );
    }

    function drawTrail(particle, now) {
        for (let j = 0; j < TRAIL_OFFSETS.length - 1; j += 1) {
            const fromOffset = TRAIL_OFFSETS[j];
            const toOffset = TRAIL_OFFSETS[j + 1];
            const fromT = (particle.t - fromOffset + 1) % 1;
            const toT = (particle.t - toOffset + 1) % 1;
            const midT = (particle.t - (fromOffset + toOffset) * 0.5 + 1) % 1;
            const progress = (j + 1) / (TRAIL_OFFSETS.length - 1);
            const alphaScale = 0.18 + progress * progress * 0.48;
            drawTrailSegment(particle, now, fromT, toT, midT, alphaScale);
        }
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

            drawTrail(particle, now);
            drawParticle(particle, now, particle.t, 1, 1);
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

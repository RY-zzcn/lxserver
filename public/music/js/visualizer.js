/**
 * Music Visualizer Integration using Wave.js
 * Manages independent footer and detail view canvases and syncs with theme color.
 */

const musicVisualizer = (function () {
    let audioContext, audioSource, audioAnalyser;
    let waveFooter, waveDetail;
    let isInitialized = false;

    const audio = document.getElementById('audio-player');
    const footerCanvas = document.getElementById('footer-visualizer');
    const detailCanvas = document.getElementById('detail-visualizer');
    const playerFooter = document.getElementById('player-footer');

    /**
     * Initialize AudioContext and AnalyserNode.
     */
    function init() {
        if (isInitialized || !window.Wave || !audio) return;

        try {
            console.log('[Visualizer] Initializing AudioContext...');
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            audioSource = audioContext.createMediaElementSource(audio);
            audioAnalyser = audioContext.createAnalyser();

            audioSource.connect(audioAnalyser);
            audioAnalyser.connect(audioContext.destination);

            audioAnalyser.smoothingTimeConstant = 0.8;
            audioAnalyser.fftSize = 512;

            waveFooter = new Wave(audioAnalyser, footerCanvas);
            waveDetail = new Wave(audioAnalyser, detailCanvas);

            isInitialized = true;
            console.log('[Visualizer] Initialized successfully');

            syncSize();
            applySettings();
        } catch (e) {
            console.error('[Visualizer] Initialization failed:', e);
        }
    }

    /**
     * Sync canvas resolutions.
     */
    function syncSize() {
        [footerCanvas, detailCanvas].forEach(canvas => {
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0) return;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        });
    }

    /**
     * Apply independent settings for Footer and Detail.
     */
    function applySettings() {
        if (!isInitialized) return;

        // 每次应用设置前同步一次尺寸，确保全宽对齐
        syncSize();

        const s = window.settings || {};
        const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--c-500').trim() || '#10b981';
        const opacity = s.visualizerOpacity !== undefined ? s.visualizerOpacity : 0.5;
        const globalStyle = s.visualizerGlobalStyle || 'blocks';
        const globalGap = globalStyle === 'blocks' ? 2 : 0;

        // --- Handle Footer Visualizer ---
        waveFooter.clearAnimations();
        const visualizerContainer = document.getElementById('visualizer-container');

        if (s.showFooterVisualizer && footerCanvas && visualizerContainer) {
            const style = s.footerVisualizerStyle || 'bars';
            // 获取容器实际宽度而不是 Canvas 宽度
            const containerRect = visualizerContainer.getBoundingClientRect();
            const containerWidth = containerRect.width;

            let count, gap, lineWidth, cubeHeight;

            if (globalStyle === 'blocks') {
                gap = 1; // 极小间距，更细腻
                lineWidth = 0;
                cubeHeight = 4; // 稍微降低高度，配合宽度
                const targetPitch = 5; // Pitch reduced (Width ~4px)

                // 计算填满宽度所需的数量 (近似值)
                const maxCount = Math.floor(containerWidth / targetPitch);
                count = Math.min(maxCount, 1024);

                // 不再强制设置像素宽度，而是让它填满容器
                //这能兼容各种屏幕尺寸和浏览器缩放，避免“前端对齐”或右侧留白问题
                footerCanvas.style.width = '100%';
                footerCanvas.style.height = '100%';
            } else {
                // 连体样式
                gap = 0;
                lineWidth = 2;
                cubeHeight = undefined;
                const targetPitch = 6;
                const maxCount = Math.floor(containerWidth / targetPitch);
                count = Math.min(maxCount, 1024);

                footerCanvas.style.width = '100%';
                footerCanvas.style.height = '100%';
            }

            // 同步物理分辨率
            syncSize();

            const options = {
                fillColor: themeColor,
                lineColor: themeColor,
                lineWidth: lineWidth,
                count: count,
                rounded: true, // 方块样式下 rounded 对 Cubes 无效或产生圆角，可保留
                bottom: true,
                gap: gap
            };

            if (cubeHeight !== undefined) {
                options.cubeHeight = cubeHeight;
            }

            let AnimationClass = waveFooter.animations.Cubes; // Default
            if (style === 'wave') {
                AnimationClass = waveFooter.animations.Wave;
            }

            waveFooter.addAnimation(new AnimationClass(options));
            footerCanvas.style.opacity = opacity;

            // 调整内容区域高度
            const footerIsHidden = playerFooter && playerFooter.classList.contains('translate-y-[110%]');

            // 增加容器高度和 Footer 高度
            visualizerContainer.style.height = '100px';
            visualizerContainer.style.zIndex = '1';
            visualizerContainer.style.display = 'flex'; // 确保可见
            if (playerFooter) {
                playerFooter.style.transition = 'height 0.3s ease';
                playerFooter.style.height = '150px';
                playerFooter.style.justifyContent = 'center'; // [Fix] 增加高度后内容保持垂直居中
            }

            // [Important] 如果音频正在播放但 Context 挂起了（常见于浏览器策略），立即恢复
            if (audioContext && audioContext.state === 'suspended' && audio && !audio.paused) {
                audioContext.resume();
            }

            // 调整内容区域的底部 Padding 以防被遮挡
            const mainViews = document.querySelectorAll('#view-search, #view-favorites, #view-settings, #view-about, #view-player-detail');
            mainViews.forEach(view => {
                view.style.transition = 'padding-bottom 0.3s ease';
                // 如果 Footer 已经隐藏了，不需要额外 Padding
                view.style.paddingBottom = footerIsHidden ? '' : '180px';
            });

            // 调整侧边栏底部 Padding
            const sidebar = document.querySelector('aside');
            if (sidebar) {
                sidebar.style.transition = 'padding-bottom 0.3s ease';
                sidebar.style.paddingBottom = footerIsHidden ? '' : '160px';
            }
        } else if (footerCanvas && visualizerContainer) {
            footerCanvas.style.opacity = '0';
            visualizerContainer.style.height = ''; // 复原 (h-12 / 48px)
            footerCanvas.style.width = '100%'; // 复原宽度
            if (playerFooter) {
                playerFooter.style.height = '';
                playerFooter.style.justifyContent = ''; // 复原
            }
            // 复原 Padding
            const mainViews = document.querySelectorAll('#view-search, #view-favorites, #view-settings, #view-about, #view-player-detail');
            mainViews.forEach(view => {
                view.style.paddingBottom = '';
            });
            const sidebar = document.querySelector('aside');
            if (sidebar) {
                sidebar.style.paddingBottom = '';
            }
        }

        // --- Handle Detail Visualizer ---
        waveDetail.clearAnimations();
        if (s.showDetailVisualizer && detailCanvas) {
            const style = s.detailVisualizerStyle || 'pulse';
            const options = {
                fillColor: themeColor,
                lineColor: themeColor,
                lineWidth: 1.5,
                count: 60,
                rounded: true,
                diameter: 220,
                gap: globalGap // 为 Pulse 等样式应用全局风格间距
            };

            let AnimationClass = waveDetail.animations.Turntable; // Default for 'pulse'

            if (style === 'dots') {
                AnimationClass = waveDetail.animations.Glob;
                options.diameter = 180;
            } else if (style === 'flower') {
                AnimationClass = waveDetail.animations.Flower;
                options.diameter = 200;
            }

            waveDetail.addAnimation(new AnimationClass(options));
            detailCanvas.style.opacity = opacity;
        } else if (detailCanvas) {
            detailCanvas.style.opacity = '0';
        }
    }

    if (audio) {
        audio.addEventListener('play', () => {
            if (!isInitialized) {
                init();
            } else if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
        });
    }

    window.addEventListener('resize', () => {
        syncSize();
        if (isInitialized) applySettings();
    });

    return { init, applySettings, syncSize };
})();

window.musicVisualizer = musicVisualizer;

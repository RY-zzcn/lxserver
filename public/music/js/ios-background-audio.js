/**
 * iOS Background Audio Keep-Alive Module
 *
 * 解决 iOS Safari 息屏断播问题。
 * 原理：在 Web Audio 图末端（analyser 之后）桥接 MediaStreamDestination，
 * 并将其输出流赋给隐藏 <audio> 元素的 srcObject，使 iOS 将其识别为活跃媒体流，
 * 从而在息屏/后台状态维持音频会话。
 *
 * 仅在 iOS 设备上激活，其他平台为 no-op。
 * 加载顺序：须在 sound-effects.js 之前加载。
 */
window.iOSBackgroundAudio = (function () {

    // 检测是否为 iOS 设备（含 iPad OS 桌面模式）
    function isIOS() {
        const ua = navigator.userAgent;
        const isIPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        return /iPhone|iPod/.test(ua) || isIPad;
    }

    let streamDestination = null;
    let anchorAudio = null;
    let isActive = false;
    let _audioContext = null;

    /**
     * 初始化 iOS 后台播放保活桥接。
     * 由 sound-effects.js 的 init() 末尾调用，在 Web Audio 图构建完成后执行。
     * @param {AudioContext} audioContext - 已有的 AudioContext
     * @param {AnalyserNode} analyserNode - 音频图末端的 Analyser 节点（输出到 destination 之前）
     */
    function init(audioContext, analyserNode) {
        if (!isIOS()) return;
        if (isActive) return;

        _audioContext = audioContext;

        try {
            // 1. 创建 MediaStreamDestination 并连接到 analyser 下游
            streamDestination = audioContext.createMediaStreamDestination();
            analyserNode.connect(streamDestination);

            // 2. 创建隐藏的 anchor <audio> 元素，作为 iOS 媒体会话锚点
            anchorAudio = document.createElement('audio');
            anchorAudio.id = 'ios-audio-anchor';
            anchorAudio.setAttribute('playsinline', '');
            anchorAudio.setAttribute('webkit-playsinline', '');
            anchorAudio.muted = false; // 非静音，iOS 需要实际音频流
            anchorAudio.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.01;pointer-events:none;';
            document.body.appendChild(anchorAudio);

            // 3. 赋值 srcObject（MediaStream）
            anchorAudio.srcObject = streamDestination.stream;

            // 4. 同步主音频播放/暂停状态
            const mainAudio = document.getElementById('audio-player');
            if (mainAudio) {
                mainAudio.addEventListener('play', onMainPlay);
                mainAudio.addEventListener('pause', onMainPause);
            }

            // 5. 监听 AudioContext 状态（处理 iOS 系统中断恢复）
            audioContext.addEventListener('statechange', onContextStateChange);

            isActive = true;
            console.log('[iOSAudio] ✅ MediaStreamDestination bridge initialized. iOS background playback enabled.');

            // 6. 立即尝试启动 anchor（此时已在用户手势上下文中）
            playAnchor();

        } catch (e) {
            console.error('[iOSAudio] Failed to initialize:', e);
        }
    }

    function onMainPlay() {
        if (!_audioContext) return;
        // 恢复 AudioContext（iOS 前后台切换后可能 suspend）
        if (_audioContext.state === 'suspended') {
            _audioContext.resume().then(() => {
                console.log('[iOSAudio] AudioContext resumed after suspend.');
                playAnchor();
            });
        } else {
            playAnchor();
        }
    }

    function onMainPause() {
        // 主动暂停时不停止 anchor，让 iOS 保持音频会话活跃
        // 这样下一首歌开始时不需要重新建立会话
    }

    function onContextStateChange() {
        if (!_audioContext) return;
        console.log('[iOSAudio] AudioContext state:', _audioContext.state);

        if (_audioContext.state === 'running') {
            const mainAudio = document.getElementById('audio-player');
            if (mainAudio && !mainAudio.paused) {
                playAnchor();
            }
        }
    }

    /**
     * 触发 anchor audio 的播放。须在用户手势上下文中调用（iOS 限制）。
     */
    function playAnchor() {
        if (!anchorAudio) return;
        if (anchorAudio.paused) {
            const p = anchorAudio.play();
            if (p) {
                p.then(() => {
                    console.log('[iOSAudio] anchor audio playing — background session active.');
                }).catch(e => {
                    // 在用户手势之外调用时预期失败，忽略
                    if (e.name !== 'NotAllowedError') {
                        console.warn('[iOSAudio] anchor play error:', e.message);
                    }
                });
            }
        }
    }

    /**
     * 公开方法：在用户有手势时主动确保 anchor 在播放。
     * 供外部（app.js 等）在播放按钮点击时调用。
     */
    function ensureAnchorPlaying() {
        if (isActive) {
            playAnchor();
        }
    }

    return {
        init,
        ensureAnchorPlaying,
        isActive: () => isActive,
        isIOS,
    };

})();

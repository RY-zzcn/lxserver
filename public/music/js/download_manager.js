/**
 * Download Manager for LX Server Web Frontend
 * Manages parallel downloads, progress tracking, pausing, resuming, retries using Fetch + ReadableStream.
 */

class DownloadManager {
    constructor() {
        this.tasks = []; // Queue of tasks
        this.maxConcurrent = window.settings?.downloadConcurrency || 3;
        this.activeCount = 0; // Currently active (local downloading + triggered server tasks)

        // UI Elements
        this.drawer = document.getElementById('download-drawer');
        this.listContainer = document.getElementById('download-list-container');
        this.globalSpeedEl = document.getElementById('download-global-speed');
        this.progressTextEl = document.getElementById('download-progress-text');

        // Speed calculation
        this.lastTotalBytes = 0;
        this.lastTime = Date.now();
        this.speedInterval = setInterval(() => this.updateGlobalSpeed(), 1000);

        // [New] Poll for server-side caching progress
        this.serverPollInterval = setInterval(() => this.pollServerProgress(), 2000);

        // Restore tasks from sessionStorage
        this.restoreTasks();
    }

    // Update max concurrency limit dynamically
    updateMaxConcurrent(value) {
        console.log('[DownloadManager] Concurrency limit updated to:', value);
        this.maxConcurrent = value;
        this.processQueue();
    }

    async pollServerProgress() {
        // [Move to top] 对已完成但还未检测过歌词的云端任务，执行检测
        // 这样即使当前没有正在下载的任务，刷新页面后也能触发一次歌词状态刷新
        this.tasks.filter(t => t.isServer && t.status === 'finished' && t.hasLyric === undefined).forEach(t => {
            t.hasLyric = 'checking';
            this.checkTaskLyric(t);
        });

        // Poll for server tasks AND local proxy tasks
        const tasksToPoll = this.tasks.filter(t => (t.isServer || (t.status === 'downloading' && !t.isServer)) && (t.status === 'waiting' || t.status === 'downloading'));
        if (tasksToPoll.length === 0) return;

        // Map task IDs to names/keys the server uses
        const idMap = {};
        tasksToPoll.forEach(t => {
            if (t.isServer) {
                // Support both 'server_<songId>' and 'server_batch_<songId>'
                const rawId = t.id.replace(/^server_(batch_)?/, '');
                idMap[rawId] = t.id;
            } else {
                // Local proxy download uses taskId directly
                idMap[t.id] = t.id;
            }
        });

        const ids = Object.keys(idMap).join(',');
        try {
            const resp = await fetch(`/api/music/cache/progress?ids=${encodeURIComponent(ids)}`);
            const result = await resp.json();
            if (result.success) {
                const data = result.data;

                // 处理有进度数据的任务
                Object.keys(data).forEach(rawId => {
                    const taskId = idMap[rawId];
                    const task = this.tasks.find(t => t.id === taskId);
                    if (!task) return;

                    const progressInfo = data[rawId];
                    if (progressInfo) {
                        // [Fix] 如果本地任务已处于暂停状态，则忽略轮询结果中的 downloading 状态覆盖，
                        // 但仍然更新收到的字节数等元数据。
                        if (task.status === 'paused' && (progressInfo.status === 'downloading' || progressInfo.status === 'waiting')) {
                            task.downloadedBytes = progressInfo.received || 0;
                            task.totalBytes = progressInfo.total || 0;
                            return;
                        }

                        // Calculate speed for polled tasks
                        if (task.lastPolledBytes !== undefined && task.lastPolledTime !== undefined) {
                            const now = Date.now();
                            const elapsed = (now - task.lastPolledTime) / 1000;
                            if (elapsed > 0) {
                                const downloaded = (progressInfo.received || 0) - task.lastPolledBytes;
                                task.speed = Math.max(0, downloaded / elapsed);
                            }
                        }
                        task.lastPolledBytes = progressInfo.received || 0;
                        task.lastPolledTime = Date.now();

                        task.status = progressInfo.status === 'finished' ? 'finished' : 'downloading';
                        task.progress = progressInfo.progress || 0;
                        task.downloadedBytes = progressInfo.received || 0;
                        task.totalBytes = progressInfo.total || 0;

                        if (progressInfo.status === 'tagging' || progressInfo.status === 'finished') {
                            task.status = 'finished';
                            task.progress = 100;
                            task.errorMsg = '';
                            // 成功完成后触发歌词同步（补充）
                            if (window.requestServerLyricCache && task.status === 'finished') {
                                window.requestServerLyricCache(task.song, task.quality).then(() => {
                                    // 延时一下再检查，确保后端写入完成
                                    setTimeout(() => this.checkTaskLyric(task), 2000);
                                });
                            }
                            this.saveTasks();
                            // If it just finished, free up the slot
                            this.processQueue();
                        } else {
                            task.errorMsg = '';
                        }
                        this.renderTask(task);
                    }
                });

                // [Fix] 处理没有进度数据的任务：key 已被删除 = 下载完成或从未开始
                tasksToPoll.forEach(task => {
                    const rawId = task.isServer ? task.id.replace(/^server_(batch_)?/, '') : task.id;
                    if (data[rawId] === undefined && (task.status === 'downloading' || task.status === 'tagging')) {
                        // 没有进度条目 + 状态是 downloading/tagging
                        // → 如果之前进度很高或在嵌入中，说明已从内存队列移除，逻辑上视为已完成
                        console.log(`[DownloadManager] Missing progress info for ${task.id}, status: ${task.status}, prog: ${task.progress}`);
                        if (task.progress >= 99 || task.status === 'tagging') {
                            task.status = 'finished';
                            task.progress = 100;
                            task.errorMsg = '';
                            task.speed = 0;

                            // 成功完成后触发歌词同步（补充）
                            if (window.requestServerLyricCache) {
                                window.requestServerLyricCache(task.song, task.quality).then(() => {
                                    setTimeout(() => this.checkTaskLyric(task), 2000);
                                });
                            }

                            this.renderTask(task);
                            this.saveTasks();
                            this.processQueue();
                        }
                    }
                });
            }
        } catch (e) {
            console.error('[DownloadManager] Server poll error:', e);
        }
    }

    // [New] 检测任务歌词是否存在
    async checkTaskLyric(task) {
        if (!task || !task.isServer || task.status !== 'finished') return;

        // [优化] 如果已经有结果，或者重试超过 3 次，则不再请求
        if (task.hasLyric !== undefined || (task.lyricRetryCount || 0) >= 3) return;

        try {
            // 记录重试次数
            task.lyricRetryCount = (task.lyricRetryCount || 0) + 1;

            const song = task.song;
            const songId = song.songmid || song.songId || song.id;
            const url = `/api/music/cache/lyric?source=${song.source}&songmid=${song.songmid || ''}&songId=${song.id || ''}`;

            // [修复] 补全认证请求头
            const headers = {
                'Content-Type': 'application/json',
                ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
            };

            const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '';
            if (username && !headers['x-user-name']) headers['x-user-name'] = username;

            const resp = await fetch(url, { headers });
            if (resp.ok) {
                task.hasLyric = true;
            } else if (resp.status === 404) {
                task.hasLyric = false;
            } else {
                // 发生非 404 错误（如 401/500/网络错误）时才重置状态以便下次重试（受次数限制）
                task.hasLyric = undefined;
            }
            this.renderTask(task);
            this.saveTasks();
        } catch (e) {
            console.warn('[DownloadManager] Failed to check lyric cache:', task.id, e);
            task.hasLyric = undefined;
        }
    }

    // [New] 手动重试下载歌词
    async retryLyric(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !task.isServer) return;

        console.log('[DownloadManager] Retrying lyric sync for:', task.song.name);
        if (window.requestServerLyricCache) {
            task.hasLyric = 'checking';
            this.renderTask(task);

            try {
                await window.requestServerLyricCache(task.song, task.quality, true); // 强制补全
                if (window.showSuccess) window.showSuccess(`已成功补全歌词: ${task.song.name}`);
                // 再次检查
                setTimeout(() => this.checkTaskLyric(task), 1500);
            } catch (e) {
                task.hasLyric = false;
                this.renderTask(task);
                this.saveTasks();
                if (window.showError) window.showError(`补全歌词失败: ${task.song.name}`);
            }
        }
    }

    // [New] 一键重试所有下载面板中缺失的歌词
    async retryAllLyrics() {
        const missingTasks = this.tasks.filter(t => t.isServer && t.status === 'finished' && t.hasLyric === false);
        if (missingTasks.length === 0) {
            if (window.showInfo) window.showInfo('没有缺失歌词的任务');
            return;
        }

        if (window.showInfo) window.showInfo(`正在尝试补全 ${missingTasks.length} 首歌曲的歌词...`);

        // 串行下载，避免并发过大
        for (const task of missingTasks) {
            await this.retryLyric(task.id);
            // 稍微等待一下
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Toggle drawer
    toggleDrawer() {
        if (this.drawer.classList.contains('translate-x-full')) {
            this.drawer.classList.remove('translate-x-full');
        } else {
            this.drawer.classList.add('translate-x-full');
        }
    }

    // Convert bytes to readable string
    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Helper to escape HTML to prevent XSS
    escapeHtml(unsafe) {
        return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    // Helper to get song cover
    getSongCover(song) {
        if (!song) return '/music/assets/logo.svg';
        return song.img || song.pic ||
            (song.meta && (song.meta.picUrl || song.meta.img)) ||
            (song.album && (song.album.picUrl || song.album.img)) ||
            '/music/assets/logo.svg';
    }

    // [Unified] Status generator for drawer lists
    getStatusHtml(icon, text, isSpin = false) {
        return `
            <div class="flex flex-col items-center justify-center h-full text-center p-10 space-y-4">
                <i class="fas ${icon} ${isSpin ? 'fa-spin' : ''} text-4xl t-text-muted opacity-20"></i>
                <p class="text-sm t-text-muted font-medium">${text}</p>
            </div>
        `;
    }

    // Add multiple tasks
    addTasks(songs) {
        // Find existing to avoid duplicates if waiting or downloading
        songs.forEach(song => {
            // Check if already in queue
            const existing = this.tasks.find(t => t.song.id === song.id && (t.status === 'waiting' || t.status === 'downloading'));
            if (!existing) {
                const isServerTask = song.isServer || false;
                const taskId = song.taskId || (isServerTask ? 'server_' : 'dl_') + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

                this.tasks.push({
                    id: taskId,
                    song: song,
                    isServer: isServerTask, // Store explicitly on task
                    quality: song.quality || '',
                    status: 'waiting',
                    errorMsg: '',
                    progress: 0,
                    downloadedBytes: 0,
                    totalBytes: 0,
                    speed: 0,
                    retryCount: 0,
                    maxRetries: 2,
                    controller: null
                });
            }
        });

        // Auto open drawer if needed
        if (this.drawer && this.drawer.classList.contains('translate-x-full')) {
            this.toggleDrawer();
        }

        this.renderList();
        this.processQueue();
        this.saveTasks();
    }

    // Process the queue based on concurrency limits
    processQueue() {
        // Recalculate true active count including triggered server tasks
        // A server task is active if its status is 'downloading', 'tagging' or 'waiting' (if waiting specifically locally but server side active?)
        // Actually, for server tasks, status 'downloading' and 'tagging' are truly active.
        const localActive = this.tasks.filter(t => !t.isServer && t.status === 'downloading').length;
        const serverActive = this.tasks.filter(t => t.isServer && (t.status === 'downloading' || t.status === 'tagging')).length;
        this.activeCount = localActive + serverActive;

        if (this.activeCount >= this.maxConcurrent) {
            this.renderList();
            this.updateGlobalProgress();
            return;
        }

        // Find next task (could be local or server)
        const nextTask = this.tasks.find(t => t.status === 'waiting');
        if (nextTask) {
            if (nextTask.isServer) {
                this.startServerDownload(nextTask);
            } else {
                this.startDownload(nextTask);
            }
            // Recurse to fill other slots
            this.processQueue();
        }
        this.renderList();
        this.updateGlobalProgress();
    }

    // Trigger backend cache for a server task
    async startServerDownload(task) {
        task.status = 'downloading'; // Change to downloading to occupy a slot
        this.renderTask(task);

        try {
            if (typeof resolveSongUrl !== 'function') throw new Error('resolveSongUrl missing');

            // 1. Resolve URL
            const targetPref = task.quality || window.settings?.preferredQuality || '320k';
            const quality = window.QualityManager ? window.QualityManager.getBestQuality(task.song, targetPref) : targetPref;
            task.quality = quality;

            const result = await resolveSongUrl(task.song, quality, true, true);
            if (!result || !result.url) throw new Error('解析失败');


            let rawUrl = result.url;
            if (rawUrl.startsWith('/api/music/download')) {
                const proxyParams = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');
                const extracted = proxyParams.get('url');
                if (extracted) rawUrl = decodeURIComponent(extracted);
            }
            if (!rawUrl.startsWith('http')) throw new Error('无法获取有效的外部下载地址');

            // 2. Post to backend
            const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

            const res = await fetch('/api/music/cache/download', {
                method: 'POST',
                headers,
                body: JSON.stringify({ songInfo: task.song, url: rawUrl, quality })
            });

            if (!res.ok) throw new Error('服务器拒绝缓存');

            // Success: pollServerProgress will now handle its movement
            console.log(`[DownloadManager] Server task started: ${task.song.name}`);
        } catch (e) {
            console.warn('[DownloadManager] Failed to start server task:', task.id, e);
            task.status = 'error';
            task.errorMsg = e.message || '启动失败';
            this.renderTask(task);
            this.processQueue(); // Release slot immediately because it's errored
        }
    }

    // Start a specific download task
    async startDownload(task) {

        task.status = 'downloading';
        task.errorMsg = '';
        task.speed = 0;
        task.controller = new AbortController();
        this.renderTask(task);

        try {
            // 1. Resolve URL and Quality
            // 始终使用 getBestQuality。如果是单曲下载，task.quality 就是确定的音质；如果是批量，就是用户选中的最高偏好。
            const targetPref = task.quality || window.settings?.preferredQuality || '320k';
            const quality = window.QualityManager.getBestQuality(task.song, targetPref);

            // 重要：将降级后的实际音质更新到任务对象中，确保后续 resolve 和 UI 显示一致
            task.quality = quality;
            this.renderTask(task);

            const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

            // Fetch the resolving URL
            const resolveRes = await fetch('/api/music/url', {
                method: 'POST',
                headers,
                body: JSON.stringify({ songInfo: task.song, quality }),
                signal: task.controller.signal
            });

            if (!resolveRes.ok) throw new Error('Failed to resolve URL');
            const resolveData = await resolveRes.json();

            if (!resolveData.url) throw new Error('No download URL found');

            let finalUrl = resolveData.url;
            let ext = resolveData.type || 'mp3';
            if (ext.startsWith('flac')) ext = 'flac'; // Handle flac24bit -> flac
            if (ext === '128k' || ext === '320k') ext = 'mp3';
            const filename = `${task.song.singer} - ${task.song.name}.${ext}`;

            // Check if we need to proxy the download itself across domains
            let shouldProxyDownload = window.settings?.enableProxyDownload || true; // Force proxy for tagging support
            if (!shouldProxyDownload && window.settings?.enableAutoProxy) {
                if (window.location.protocol === 'https:' && finalUrl.startsWith('http://')) {
                    shouldProxyDownload = true;
                }
            }

            if (shouldProxyDownload && !finalUrl.startsWith('/api/music/download')) {
                // Add metadata for tagging — 用 albumName 优先（playlist 字段），album 为兼容备选
                const albumName = task.song.albumName || (task.song.album && typeof task.song.album === 'string' ? task.song.album : (task.song.album?.name || ''));
                let coverUrl = this.getSongCover(task.song);

                // [Critical Fix] 相对路径改为绝对路径，服务器才能正确抓取并嵌入封面
                if (coverUrl && coverUrl.startsWith('/')) {
                    coverUrl = window.location.origin + coverUrl;
                }

                const metadataParams = [
                    `tag=1`,
                    `name=${encodeURIComponent(task.song.name)}`,
                    `singer=${encodeURIComponent(task.song.singer)}`,
                    `album=${encodeURIComponent(albumName)}`,
                    coverUrl ? `pic=${encodeURIComponent(coverUrl)}` : ''
                ].filter(Boolean).join('&');

                finalUrl = `/api/music/download?url=${encodeURIComponent(finalUrl)}&filename=${encodeURIComponent(filename)}&taskId=${task.id}&${metadataParams}`;
                console.log('[DownloadManager] Download with metadata proxy:', finalUrl);
            } else {
                console.log('[DownloadManager] Simple download:', finalUrl);
            }

            // 2. Fetch the actual file using Streams to track progress
            const response = await fetch(finalUrl, { signal: task.controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status} when fetching file`);

            const contentLength = response.headers.get('content-length');
            if (contentLength) {
                task.totalBytes = parseInt(contentLength, 10);
            } else {
                // Unknown length
                task.totalBytes = 0;
            }

            const reader = response.body.getReader();
            let receivedLength = 0;
            const chunks = [];

            // Time tracking for speed calc using short intervals
            let lastUpdate = performance.now();
            let downloadedSinceLastUpdate = 0;

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                chunks.push(value);
                receivedLength += value.length;
                task.downloadedBytes = receivedLength;
                downloadedSinceLastUpdate += value.length;

                if (task.totalBytes) {
                    task.progress = Math.round((receivedLength / task.totalBytes) * 100);
                }

                // Update speed every 500ms
                const now = performance.now();
                if (now - lastUpdate > 500) {
                    const elapsedSecs = (now - lastUpdate) / 1000;
                    task.speed = downloadedSinceLastUpdate / elapsedSecs;
                    lastUpdate = now;
                    downloadedSinceLastUpdate = 0;
                    // console.log(`[DownloadManager] Progress: ${task.progress}%, Speed: ${task.speed}`);
                    this.renderTask(task); // Update DOM smoothly
                }
            }

            // 3. Complete and Merge Chunks to Blob
            task.progress = 100;
            task.speed = 0;

            task.status = 'finished';
            this.renderTask(task);

            this.activeCount--;
            this.saveTasks();

            // Construct Blob and trigger browser download
            const blob = new Blob(chunks);
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // 标记真正结束
            task.status = 'finished';
            this.renderTask(task);

            // Clean up to free memory
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

            // Trigger next
            this.processQueue();

        } catch (error) {
            this.activeCount--;
            if (task.controller && task.controller.signal.aborted) {
                task.status = 'paused';
                task.errorMsg = '已暂停';
            } else {
                console.error(`Download error for ${task.song.name}:`, error);
                task.errorMsg = error.message;

                // Retry logic
                if (task.retryCount < task.maxRetries) {
                    task.retryCount++;
                    task.status = 'error'; // Show error momentarily
                    this.renderTask(task);

                    // Add to end of queue after 2 seconds
                    setTimeout(() => {
                        // [Critical Fix] 检查任务是否在这 2 秒内被用户手动取消或暂停
                        if (task.controller?.signal?.aborted || task.status === 'paused' || task.status === 'finished') {
                            console.log('[DownloadManager] Abort retry for task:', task.id);
                            return;
                        }

                        // Create a new task effectively at the end but keeping retry count
                        const newTask = { ...task, status: 'waiting', errorMsg: '', downloadedBytes: 0, progress: 0, controller: null };
                        this.tasks = this.tasks.filter(t => t.id !== task.id);
                        this.tasks.push(newTask);
                        this.renderList();
                        this.processQueue();
                    }, 2000);
                    return; // exit current cycle
                } else {
                    task.status = 'error';
                }
            }
            this.renderTask(task);
            this.processQueue();
        }
    }

    pauseTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.isServer) {
            // 云端任务：通知后端停止，并更新本地状态
            if (task.status === 'downloading' || task.status === 'waiting') {
                const songKey = task.id.replace(/^server_(batch_)?/, '');
                const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

                fetch('/api/music/cache/stop', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ songKey })
                }).catch(e => console.warn('[DownloadManager] Failed to stop server task:', e));
                task.status = 'paused';
                task.errorMsg = '已暂停';
                this.renderTask(task);
            }
        } else {
            // 本地任务
            if (task.status === 'downloading') {
                if (task.controller) {
                    task.controller.abort(); // Triggers catch block in startDownload
                }
            } else if (task.status === 'waiting') {
                task.status = 'paused';
                this.renderTask(task);
            }
        }
    }

    resumeTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || (task.status !== 'paused' && task.status !== 'error')) return;

        task.status = 'waiting';
        task.downloadedBytes = 0;
        task.progress = 0;
        this.renderTask(task);

        if (task.isServer) {
            // 云端任务：恢复时由于后端进程可能已中止，需要重新触发解析与下载
            (async () => {
                try {
                    if (typeof resolveSongUrl !== 'function') throw new Error('resolveSongUrl not available');
                    // 重新获取音质编码（处理显示名称）
                    let quality = task.quality;
                    if (window.QualityManager) {
                        quality = window.QualityManager.getBestQuality(task.song, quality);
                    }
                    const result = await resolveSongUrl(task.song, quality, true, true);
                    if (!result || !result.url) throw new Error('获取播放地址失败');

                    // [Fix] 还原代理 URL 为原始外部 URL
                    let rawUrl = result.url;
                    if (rawUrl.startsWith('/api/music/download')) {
                        const proxyParams = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');
                        const extracted = proxyParams.get('url');
                        if (extracted) rawUrl = decodeURIComponent(extracted);
                    }
                    if (!rawUrl.startsWith('http')) throw new Error('无法获取有效的外部下载地址');

                    const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

                    const res = await fetch('/api/music/cache/download', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ songInfo: task.song, url: rawUrl, quality })
                    });
                    if (!res.ok) throw new Error('服务器拒绝请求');

                    task.status = 'downloading';
                    this.renderTask(task);
                } catch (err) {
                    console.warn('[DownloadManager] Resume cloud task failed:', task.song.name, err);
                    task.status = 'error';
                    task.errorMsg = err.message || '恢复失败';
                    this.renderTask(task);
                }
            })();
        } else {
            // 本地任务
            this.processQueue();
        }
    }

    deleteTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
            if (task.isServer && (task.status === 'downloading' || task.status === 'waiting')) {
                // 云端任务：通知后端停止
                const songKey = task.id.replace(/^server_(batch_)?/, '');
                const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

                fetch('/api/music/cache/stop', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ songKey })
                }).catch(e => console.warn('[DownloadManager] Failed to stop server task on delete:', e));
            } else if (!task.isServer && task.status === 'downloading' && task.controller) {
                task.controller.abort();
            }
            this.tasks = this.tasks.filter(t => t.id !== taskId);
            this.renderList();
            this.processQueue();
            this.saveTasks();
        }
    }

    pauseAll() {
        this.tasks.forEach(t => {
            if (t.status === 'downloading' || t.status === 'waiting') {
                this.pauseTask(t.id);
            }
        });
    }

    resumeAll() {
        this.tasks.forEach(t => {
            if (t.status === 'paused') {
                this.resumeTask(t.id);
            }
        });
    }

    retryAllFailed() {
        // 取出所有失败任务的快照，避免在遍历同时修改数组引起问题
        const failedTasks = this.tasks.filter(t => t.status === 'error');
        if (failedTasks.length === 0) return;

        failedTasks.forEach(t => {
            t.retryCount = 0;
            t.downloadedBytes = 0;
            t.progress = 0;
            t.errorMsg = '';
            // 移到队列末尾
            this.tasks = this.tasks.filter(x => x.id !== t.id);

            if (t.isServer) {
                // 云端任务：重新 resolve URL 并触发后端下载
                t.status = 'waiting';
                this.tasks.push(t);
                this.renderTask(t);

                // 异步重新触发云端下载
                (async () => {
                    try {
                        if (typeof resolveSongUrl !== 'function') throw new Error('resolveSongUrl not available');
                        // 尝试通过 QualityManager 将可能是显示名称的 quality 转换为原始 code
                        let quality = t.quality;
                        if (window.QualityManager) {
                            // getBestQuality 能处理原始 code 和 preferred 偏好，传入 t.quality 作为偏好，让其降级匹配
                            quality = window.QualityManager.getBestQuality(t.song, quality);
                        }
                        const result = await resolveSongUrl(t.song, quality, true, true);
                        if (!result || !result.url) throw new Error('获取地址失败');

                        // [Fix] 还原代理 URL 为原始外部 URL
                        let rawUrl = result.url;
                        if (rawUrl.startsWith('/api/music/download')) {
                            const proxyParams = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');
                            const extracted = proxyParams.get('url');
                            if (extracted) rawUrl = decodeURIComponent(extracted);
                        }
                        if (!rawUrl.startsWith('http')) throw new Error('无法获取有效的外部下载地址');

                        const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };

                        const res = await fetch('/api/music/cache/download', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ songInfo: t.song, url: rawUrl, quality })
                        });
                        if (!res.ok) throw new Error('服务器拒绝缓存');

                        t.status = 'downloading';
                        this.renderTask(t);
                    } catch (err) {
                        console.warn('[DownloadManager] Retry cloud task failed:', t.song.name, err);
                        t.status = 'error';
                        t.errorMsg = err.message || '重试失败';
                        this.renderTask(t);
                    }
                })();
            } else {
                // 本地任务：放回队列等待 processQueue 调度
                t.status = 'waiting';
                this.tasks.push(t);
            }
        });

        this.renderList();
        this.processQueue();
    }

    clearCompleted() {
        this.tasks = this.tasks.filter(t => t.status !== 'finished');
        this.renderList();
        this.saveTasks();
    }

    clearAll() {
        // 先弹确认框
        if (typeof showSelect === 'function') {
            showSelect('停止并清空任务', '确认要立即停止所有进行中的任务并清空列表吗？', {
                confirmText: '确认停止',
                danger: true
            }).then(confirmed => {
                if (!confirmed) return;
                this.tasks.forEach(t => {
                    // 本地任务调用 abort
                    if ((t.status === 'downloading' || t.status === 'waiting') && t.controller) {
                        try { t.controller.abort(); } catch (e) { }
                    }
                });

                // [NEW] 通知服务器中止所有该用户的缓存任务
                const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '';
                fetch('/api/music/cache/stop', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-user-name': username
                    },
                    body: JSON.stringify({ all: true })
                }).catch(err => console.error('[DownloadManager] Failed to stop server tasks:', err));

                this.tasks = [];
                this.activeCount = 0;
                this.renderList();
                this.saveTasks();
            });
        } else {
            // fallback：直接清空
            this.tasks.forEach(t => {
                if (t.status === 'downloading' && t.controller) t.controller.abort();
            });
            this.tasks = [];
            this.activeCount = 0;
            this.renderList();
            this.saveTasks();
        }
    }

    // Persist tasks to sessionStorage
    saveTasks() {
        try {
            // Serialize only the data we need, not the AbortController
            const data = this.tasks.map(t => ({
                id: t.id,
                song: t.song,
                isServer: t.isServer,
                quality: t.quality,
                status: t.status === 'downloading' ? (t.isServer ? 'waiting' : 'waiting') : t.status,
                progress: t.status === 'finished' ? 100 : (t.isServer ? t.progress : 0),
                errorMsg: t.errorMsg || '',
                retryCount: t.retryCount || 0,
                maxRetries: t.maxRetries || 2
            }));
            sessionStorage.setItem('lx_download_tasks', JSON.stringify(data));
        } catch (e) {
            console.warn('[DownloadManager] Failed to save tasks to sessionStorage:', e);
        }
    }

    // Restore tasks from sessionStorage on page load
    restoreTasks() {
        try {
            const raw = sessionStorage.getItem('lx_download_tasks');
            if (!raw) return;
            const data = JSON.parse(raw);
            if (!Array.isArray(data) || data.length === 0) return;

            data.forEach(t => {
                this.tasks.push({
                    id: t.id,
                    song: t.song,
                    isServer: t.isServer || false,
                    quality: t.quality || '',
                    // Local downloading → reset to waiting to re-download; server/finished → keep status
                    status: t.status,
                    progress: t.progress || 0,
                    downloadedBytes: 0,
                    totalBytes: 0,
                    speed: 0,
                    errorMsg: t.errorMsg || '',
                    retryCount: t.retryCount || 0,
                    maxRetries: t.maxRetries || 2,
                    controller: null
                });
            });

            this.renderList();
            // Start queued local tasks
            this.processQueue();
            console.log(`[DownloadManager] Restored ${data.length} tasks from sessionStorage`);
        } catch (e) {
            console.warn('[DownloadManager] Failed to restore tasks from sessionStorage:', e);
        }
    }

    // Update the UI Global Speed Counter
    updateGlobalSpeed() {
        let totalSpeed = 0;
        let active = 0;
        let pctTotal = 0;
        let pctCount = 0;

        this.tasks.forEach(t => {
            if (t.status === 'downloading') {
                totalSpeed += (t.speed || 0);
                active++;
            }
            // 所有任务都纳入进度计算（server 任务可能 totalBytes=0，但 progress/status 是已知的）
            if (t.status === 'finished') {
                pctTotal += 100;
                pctCount++;
            } else if (t.status === 'downloading' || t.status === 'waiting') {
                pctTotal += (t.progress || 0);
                pctCount++;
            }
        });

        if (this.globalSpeedEl) {
            this.globalSpeedEl.innerText = `${this.formatSize(totalSpeed)}/s • ${this.tasks.length} TASKS`;
        }

        if (this.progressTextEl) {
            const overallProgress = pctCount > 0 ? Math.round(pctTotal / pctCount) : 0;
            this.progressTextEl.innerText = `${overallProgress}%`;
        }
    }

    updateGlobalProgress() {
        this.updateGlobalSpeed(); // Calculates and updates
    }

    // Render a single task row item to HTML
    renderTaskHtml(task) {
        const coverSrc = this.getSongCover(task.song);
        const sourceName = {
            'wy': '网易', 'tx': 'QQ', 'kg': '酷狗', 'kw': '酷我', 'mg': '咪咕'
        }[task.song.source] || task.song.source;

        let qualityLabel = task.quality || window.settings?.preferredQuality || '优先最高';
        // 如果是音质代码（如 320k），尝试转换为显示名称
        if (window.QualityManager) {
            // 先尝试把代码转换成名称（如 320k -> 高品质）
            const displayName = window.QualityManager.getQualityDisplayName(qualityLabel);
            if (displayName) qualityLabel = displayName;
        }

        let statusBg = 'bg-gray-100 t-text-muted';
        let statusText = '等待中';
        let actionBtnHTML = '';
        let progressWidth = task.progress || 0;
        let speedText = '';
        let isServerTask = task.isServer || false;

        if (task.status === 'downloading') {
            statusBg = isServerTask ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600';
            // 云端任务：若 totalBytes=0 且 progress=0，说明还没轮询到进度，显示 indeterminate 而非 "云端 0%"
            const hasRealProgress = isServerTask && (task.totalBytes > 0 || task.progress > 0);
            statusText = isServerTask
                ? (hasRealProgress ? `云端 ${progressWidth}%` : '云端下载中')
                : `${progressWidth}%`;
            speedText = task.speed > 0 ? `${this.formatSize(task.speed)}/s` : '';

            if (!isServerTask) {
                actionBtnHTML = `
                    <button onclick="window.SystemDownloadManager.pauseTask('${task.id}')" class="w-8 h-8 rounded-full border border-yellow-200 text-yellow-500 hover:bg-yellow-50 flex items-center justify-center transition-colors shadow-sm" title="暂停">
                        <i class="fas fa-pause text-xs"></i>
                    </button>
                `;
            }
        } else if (task.status === 'paused') {
            statusBg = 'bg-yellow-100 text-yellow-600';
            statusText = '已暂停';
            actionBtnHTML = `
                <button onclick="window.SystemDownloadManager.resumeTask('${task.id}')" class="w-8 h-8 rounded-full border border-emerald-200 text-emerald-500 hover:bg-emerald-50 flex items-center justify-center transition-colors shadow-sm" title="继续">
                    <i class="fas fa-play text-xs"></i>
                </button>
            `;
        } else if (task.status === 'error') {
            statusBg = 'bg-red-100 text-red-600';
            statusText = task.retryCount > 0 && task.retryCount < task.maxRetries ? `重试 (${task.retryCount})` : '失败';
            actionBtnHTML = `
                <button onclick="window.SystemDownloadManager.resumeTask('${task.id}')" class="w-8 h-8 rounded-full border border-red-200 text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors shadow-sm" title="重试">
                    <i class="fas fa-redo text-xs"></i>
                </button>
            `;
        } else if (task.status === 'finished') {
            statusBg = 'bg-emerald-100 text-emerald-600';
            statusText = isServerTask ? '已存云端' : '已完成';
            progressWidth = 100;
        } else if (task.status === 'waiting') {
            statusText = isServerTask ? '云端排队' : '等待中';
            if (!isServerTask) {
                actionBtnHTML = `
                    <button onclick="window.SystemDownloadManager.pauseTask('${task.id}')" class="w-8 h-8 rounded-full border border-yellow-200 text-yellow-500 hover:bg-yellow-50 flex items-center justify-center transition-colors shadow-sm" title="暂停">
                        <i class="fas fa-pause text-xs"></i>
                    </button>
                `;
            }
        }

        // Always show delete button mostly
        if (task.status !== 'downloading' || isServerTask) {
            actionBtnHTML += `
                <button onclick="window.SystemDownloadManager.deleteTask('${task.id}')" class="w-8 h-8 rounded-full border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors ml-1 shadow-sm" title="移除任务">
                    <i class="fas fa-trash-alt text-xs"></i>
                </button>
            `;
        } else {
            actionBtnHTML += `
                <button onclick="window.SystemDownloadManager.deleteTask('${task.id}')" class="w-8 h-8 rounded-full border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors ml-1 shadow-sm" title="取消下载">
                    <i class="fas fa-times text-xs"></i>
                </button>
            `;
        }

        return `
            <div id="dl-task-${task.id}" class="relative p-3 rounded-xl t-bg-panel hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors border border-transparent hover:t-border-main group flex gap-3 overflow-hidden shadow-sm mb-2">
                <!-- Progress Bar Background -->
                ${task.status !== 'waiting' && task.status !== 'error' ? `
                <div class="absolute bottom-0 left-0 h-1.5 ${isServerTask ? 'bg-orange-400' : 'bg-emerald-400'} transition-all duration-300 opacity-60" style="width: ${progressWidth}%"></div>
                ` : ''}

                <!-- Cover -->
                <div class="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 shadow-sm border t-border-main">
                    <img src="${this.escapeHtml(coverSrc)}" class="w-full h-full object-cover">
                    ${(task.status === 'downloading') ? `
                    <div class="absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-[2px]">
                        <i class="fas ${(isServerTask ? 'fa-cloud-upload-alt' : 'fa-spinner fa-spin')} text-white text-xs"></i>
                    </div>` : ''}
                </div>

                <!-- Info -->
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                    <div class="flex items-center gap-1.5 mb-1 flex-nowrap">
                        <span class="shrink-0 text-[10px] font-bold text-white ${isServerTask ? 'bg-orange-500' : 'bg-red-400'} px-1.5 py-0.5 rounded uppercase tracking-wider">${this.escapeHtml(sourceName)}</span>
                        <span class="shrink-0 text-[10px] font-bold text-white ${isServerTask ? 'bg-purple-500' : 'bg-sky-500'} px-1.5 py-0.5 rounded tracking-wider">${isServerTask ? '云端' : '本地'}</span>
                        <h4 class="text-sm font-bold t-text-main truncate leading-tight flex-1 min-w-0 dynamic-marquee overflow-hidden" data-text="${this.escapeHtml(task.song.name)}">${this.escapeHtml(task.song.name)}</h4>
                    </div>
                    
                    <div class="flex items-center justify-between mt-1">
                        <div class="text-[10px] t-text-muted truncate flex gap-2 items-center">
                            <span class="text-emerald-600 font-medium px-1 bg-emerald-50 rounded">${this.escapeHtml(qualityLabel)}</span>
                            <span class="truncate opacity-60">${this.escapeHtml(task.song.singer)}</span>
                        </div>
                        
                        <div class="flex items-center gap-1.5 font-bold">
                            ${speedText ? `<span class="text-[10px] font-mono text-emerald-500">${speedText}</span>` : ''}
                            
                            <!-- LRC Status Tag -->
                            ${isServerTask && task.status === 'finished' ? `
                                ${task.hasLyric === true ? `
                                    <span class="text-[9px] bg-emerald-500 text-white px-1 rounded h-3.5 flex items-center shadow-sm" title="歌词已同步">LRC</span>
                                ` : task.hasLyric === false ? `
                                    <div onclick="event.stopPropagation(); window.SystemDownloadManager.retryLyric('${task.id}')" class="text-[9px] bg-red-400 hover:bg-red-500 text-white px-1 rounded h-3.5 flex items-center gap-0.5 cursor-pointer shadow-sm transition-colors" title="歌词缺失，点击重试">
                                        <span>LRC+</span>
                                        <i class="fas fa-redo-alt text-[7px]"></i>
                                    </div>
                                ` : `
                                    <span class="text-[9px] bg-gray-400 text-white px-1 rounded h-3.5 flex items-center opacity-60" title="正在检查歌词...">LRC</span>
                                `}
                            ` : ''}

                            <span class="text-[10px] px-1.5 py-0.5 rounded ${statusBg} truncate max-w-[100px]">
                                ${task.errorMsg ? `<span title="${this.escapeHtml(task.errorMsg)}">${this.escapeHtml(task.errorMsg)}</span>` : statusText}
                            </span>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="flex items-center pl-1 opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0">
                    ${actionBtnHTML}
                </div>
            </div>
        `;
    }

    // Refresh entire list DOM
    renderList() {
        if (!this.listContainer) return;

        if (this.tasks.length === 0) {
            this.listContainer.innerHTML = this.getStatusHtml('fa-inbox', '暂无下载任务');
            return;
        }

        this.listContainer.innerHTML = this.tasks.map(t => this.renderTaskHtml(t)).join('');
        // 触发标题滚动检测
        if (typeof applyMarqueeChecks === 'function') applyMarqueeChecks();
    }

    // Update specific task in DOM to avoid full re-render
    renderTask(task) {
        if (!this.listContainer) return;
        const taskEl = document.getElementById(`dl-task-${task.id}`);
        if (!taskEl) {
            // Task element doesn't exist (maybe switched views?), do full render
            this.renderList();
            return;
        }

        // Quick efficient replacement
        const div = document.createElement('div');
        div.innerHTML = this.renderTaskHtml(task);
        const newEl = div.firstElementChild;
        taskEl.parentNode.replaceChild(newEl, taskEl);
        // 触发标题滚动检测
        if (typeof applyMarqueeChecks === 'function') applyMarqueeChecks();
    }
}

// Global UI Toggles for Download Drawer
window.toggleDownloadDrawer = function () {
    if (window.SystemDownloadManager) {
        window.SystemDownloadManager.toggleDrawer();
    }
};

window.openDownloadManager = function () {
    if (window.SystemDownloadManager) {
        if (window.SystemDownloadManager.drawer.classList.contains('translate-x-full')) {
            window.SystemDownloadManager.toggleDrawer();
        }
    }
};

// Initialize globally
window.SystemDownloadManager = new DownloadManager();

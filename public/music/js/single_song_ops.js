// Single song deletion
async function deleteSingleSong(songId) {
    if (!(await showSelect('删除歌曲', '确定要删除这首歌曲吗?', { danger: true }))) {
        return;
    }

    const activeListId = getCurrentActiveListId();
    if (!activeListId || !currentListData) {
        showError('无法确定当前列表');
        return;
    }

    if (window.SyncManager.mode === 'local') {
        // Local mode: Use user credentials
        const username = localStorage.getItem('lx_sync_user');
        const password = localStorage.getItem('lx_sync_pass');

        if (!username || !password) {
            showError('请先登录本地账号');
            return;
        }

        try {
            const res = await fetch('/api/music/user/list/remove', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getUserAuthHeaders()
                },
                body: JSON.stringify({
                    listId: activeListId,
                    songIds: [songId]
                })
            });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(errorText || '删除失败');
            }

            // Reload data from server
            const data = await window.SyncManager.sync();
            const oldUsername = currentListData ? currentListData.username : null;
            currentListData = data;
            if (oldUsername) currentListData.username = oldUsername; // Preserve username
            localStorage.setItem('lx_list_data', JSON.stringify(data));
            renderMyLists(data);

            // Refresh current view
            handleListClick(activeListId);

            console.log('[Single] 本地模式删除成功');

        } catch (e) {
            showError('删除失败: ' + e.message);
            console.error('[Single] 删除错误:', e);
        }
    } else if (window.SyncManager.mode === 'remote') {
        // Remote mode: Modify cache
        try {
            const listToModify = getListById(activeListId);
            if (!listToModify) {
                throw new Error('找不到当前列表');
            }

            // Remove item from list
            const remainingItems = listToModify.filter(item => item.id !== songId);
            setListById(activeListId, remainingItems);

            // Save to cache
            localStorage.setItem('lx_list_data', JSON.stringify(currentListData));
            console.log('[Single] WS模式:已修改缓存,下次连接时将同步');

            // If currently connected, push the change immediately
            if (window.SyncManager.client && window.SyncManager.client.isConnected) {
                try {
                    await pushDataChange();
                    console.log('[Single] WS模式:实时推送成功');
                } catch (e) {
                    console.warn('[Single] WS推送失败(将在下次连接时同步):', e);
                }
            }

            // Update UI
            renderMyLists(currentListData);
            handleListClick(activeListId);

        } catch (e) {
            showError('删除失败: ' + e.message);
            console.error('[Single] WS删除错误:', e);
        }
    }
}

/**
 * 辅助函数：根据设置触发服务器端歌词缓存
 * @param {Object} song 歌曲信息
 * @param {String} quality 音质
 * @param {Boolean} force 是否强制同步（忽略设置开关，用于手动点击按钮）
 */
async function requestServerLyricCache(song, quality = null, force = false) {
    if (!force && (typeof settings === 'undefined' || settings.enableServerLyricCache === false)) return;

    console.log(`[Lyric] 尝试同步下载歌词缓存: ${song.name} (${quality || 'auto'})`);
    try {
        const source = song.source;
        const songmid = song.songmid;
        const name = encodeURIComponent(song.name);
        const singer = encodeURIComponent(song.singer);
        const hash = song.hash || '';
        const interval = song.interval || '';

        // 1. 先尝试获取歌词数据
        const lyricUrl = `/api/music/lyric?source=${source}&songmid=${songmid}&name=${name}&singer=${singer}&hash=${hash}&interval=${interval}`;
        const lRes = await fetch(lyricUrl);
        if (!lRes.ok) return;
        const lyricInfo = await lRes.json();

        if (!lyricInfo || (!lyricInfo.lyric && !lyricInfo.lrc)) return;

        // 2. 将歌词推送到服务器缓存接口
        const cacheUrl = `/api/music/cache/lyric`;
        const headers = {
            'Content-Type': 'application/json',
            ...getUserAuthHeaders()
        };

        // 构建包含音质信息的 songInfo
        const songInfoForCache = { ...song };
        if (quality) songInfoForCache.quality = quality;

        await fetch(cacheUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                songInfo: songInfoForCache,
                lyricsObj: lyricInfo
            })
        });
        console.log(`[Lyric] 歌曲下载触发的歌词缓存同步成功: ${song.name}`);
    } catch (e) {
        console.warn(`[Lyric] 自动同步歌词缓存失败: ${song.name}`, e);
    }
}

// Placeholder for download function
// Download single song
// Download single song
async function downloadSong(songOrId, forceQuality = null, suppressAlerts = false, skipPromptTarget = null) {
    let song;
    if (typeof songOrId === 'object') {
        song = songOrId;
    } else {
        if (!currentPlaylist) return false;
        song = currentPlaylist.find(s => s.id === songOrId);
    }

    if (!song) {
        if (!suppressAlerts) showError('未找到歌曲信息');
        return false;
    }

    let selected = skipPromptTarget;
    if (!selected) {
        const options = ['浏览器下载', '缓存到服务器'];
        selected = await showOptions('下载与缓存', `选择对 [${song.name}] 的操作：`, options);
    }
    if (!selected) return false;

    if (selected === '浏览器下载') {
        if (window.SystemDownloadManager) {
            const availableQualities = window.QualityManager ? window.QualityManager.getAvailableQualities(song) : ['128k'];
            const qualityDisplayNames = availableQualities.map(q => {
                const name = window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q;
                const size = song._types?.[q]?.size || song.types?.find(t => t.type === q)?.size;
                return size ? `${name} [${size}]` : name;
            });
            const selectedQualityDisplay = await showOptions('选择下载音质', `请选择对 [${song.name}] 的下载音质：`, qualityDisplayNames);
            if (!selectedQualityDisplay) return false;

            const selectedQualityIndex = qualityDisplayNames.indexOf(selectedQualityDisplay);
            const targetQuality = availableQualities[selectedQualityIndex];

            window.SystemDownloadManager.addTasks([{
                ...song,
                quality: targetQuality
            }]);

            // [新增] 如果开启了服务器歌词缓存，下载时自动同步
            // requestServerLyricCache(song, targetQuality); // [Removed] Delay until success

            if (!suppressAlerts) showInfo(`已添加任务，您可以在右侧下载管理面板查看进度`);
            return true;
        } else {
            showError('下载管理器未就绪');
            return false;
        }
    } else if (selected === '缓存到服务器') {
        let targetQuality = forceQuality;
        if (!targetQuality) {
            // 获取该歌曲实际支持的音质列表
            const availableQualities = window.QualityManager ? window.QualityManager.getAvailableQualities(song) : ['128k'];
            const qualityDisplayNames = availableQualities.map(q => {
                const name = window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q;
                const size = song._types?.[q]?.size || song.types?.find(t => t.type === q)?.size;
                return size ? `${name} [${size}]` : name;
            });
            const selectedQualityDisplay = await showOptions('选择缓存音质', `请选择对 [${song.name}] 的缓存音质：`, qualityDisplayNames);
            if (!selectedQualityDisplay) return false;

            const selectedQualityIndex = qualityDisplayNames.indexOf(selectedQualityDisplay);
            targetQuality = availableQualities[selectedQualityIndex];
        }

        // [新增] 权限校验：受限公开用户需要验证管理员
        const isPublic = !window.currentListData?.username || window.currentListData?.username === 'default';
        const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
        const isAdmin = !!localStorage.getItem('lx_admin_password');
        const isServerCacheAllowed = window.settings?.enableServerCache === true;

        if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
            showError('权限限制：缓存到服务器需要验证管理员。');
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('缓存到服务器需要验证管理员身份');
                if (!authorized) return false;
            } else {
                return false;
            }
        }

        try {
            // [Unified] 统一交给下载管理器调度
            if (window.SystemDownloadManager) {
                window.SystemDownloadManager.addTasks([{
                    ...song,
                    taskId: 'server_' + (song.id || song.songmid),
                    isServer: true,
                    quality: targetQuality // Let DM handle best quality resolution
                }]);
                if (!suppressAlerts) showInfo(`已添加云端缓存任务`);
                return true;
            } else {
                showError('下载管理器未就绪');
                return false;
            }
        } catch (e) {
            if (!suppressAlerts) showError('操作失败: ' + e.message);
            return false;
        }
    }
    return false;
}

// Batch download function
async function batchDownloadFromList() {
    if (selectedItems.size === 0) {
        showError('请先选择要下载的歌曲');
        return;
    }

    // Convert IDs to Songs
    const songsToDownload = [];
    const findSong = (list, id) => list.find(s => String(s.id) === String(id));

    selectedItems.forEach(id => {
        let song = null;
        if (selectedSongObjects && selectedSongObjects.has(id)) song = selectedSongObjects.get(id);
        if (!song && typeof viewingPlaylist !== 'undefined' && viewingPlaylist) song = findSong(viewingPlaylist, id);
        if (!song && currentPlaylist) song = findSong(currentPlaylist, id);
        if (!song && currentListData) {
            if (currentListData.defaultList) song = findSong(currentListData.defaultList, id);
            if (!song && currentListData.loveList) song = findSong(currentListData.loveList, id);
            if (!song && currentListData.userList) {
                for (const uList of currentListData.userList) {
                    song = findSong(uList.list, id);
                    if (song) break;
                }
            }
        }
        if (song) songsToDownload.push(song);
    });

    if (songsToDownload.length === 0) {
        showError('未找到选中歌曲的详细信息');
        return;
    }

    // Prompt user for download location
    const options = ['浏览器下载', '缓存到服务器'];
    const selected = await showOptions('批量下载与缓存', `选择了 ${songsToDownload.length} 首歌曲，请选择操作：`, options);

    if (!selected) return;

    if (selected === '浏览器下载') {
        if (window.SystemDownloadManager) {
            // 固定显示四个标准音质
            const availableQualities = window.QualityManager ? window.QualityManager.QUALITY_PRIORITY : ['flac24bit', 'flac', '320k', '128k'];
            const qualityDisplayNames = availableQualities.map(q => window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q);
            const selectedQualityDisplay = await showOptions('选择下载音质', `请选择批量下载的音质：\n下载歌曲的音质将取不超过该音质的最大音质`, qualityDisplayNames);

            if (!selectedQualityDisplay) return;
            const selectedQualityIndex = qualityDisplayNames.indexOf(selectedQualityDisplay);
            const targetQuality = availableQualities[selectedQualityIndex];

            const tasks = songsToDownload.map(s => {
                // 计算该歌曲实际支持的最高音质（不超过用户选中的目标音质）
                const actualQuality = window.QualityManager ? window.QualityManager.getBestQuality(s, targetQuality) : targetQuality;
                return {
                    ...s,
                    quality: actualQuality
                };
            });

            window.SystemDownloadManager.addTasks(tasks);

            /* // [Removed] Delay until success
            if (typeof settings !== 'undefined' && settings.enableServerLyricCache !== false) {
                songsToDownload.forEach(s => {
                    const actualQuality = window.QualityManager ? window.QualityManager.getBestQuality(s, targetQuality) : targetQuality;
                    requestServerLyricCache(s, actualQuality);
                });
            }
            */

            showInfo(`已将 ${songsToDownload.length} 项任务添加到下载列表，您可以前往右侧下载管理面板查看进度`);
            // Clean up selection optionally
            if (typeof deselectAll === 'function') deselectAll();
        } else {
            showError('下载管理器未就绪');
        }
    } else if (selected === '缓存到服务器') {
        // 固定显示四个标准音质
        const availableQualities = window.QualityManager ? window.QualityManager.QUALITY_PRIORITY : ['flac24bit', 'flac', '320k', '128k'];
        const qualityDisplayNames = availableQualities.map(q => window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q);
        const selectedQualityDisplay = await showOptions('选择全局缓存音质', `请选择批量请求服务器缓存的音质，下载歌曲的音质将取不超过该音质的最大音质`, qualityDisplayNames);

        if (!selectedQualityDisplay) return;
        const selectedQualityIndex = qualityDisplayNames.indexOf(selectedQualityDisplay);
        const targetQuality = availableQualities[selectedQualityIndex];

        // [新增] 权限校验：受限公开用户需要验证管理员
        const isPublic = !window.currentListData?.username || window.currentListData?.username === 'default';
        const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
        const isAdmin = !!localStorage.getItem('lx_admin_password');
        const isServerCacheAllowed = window.settings?.enableServerCache === true;

        if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
            showError('权限限制：缓存到服务器需要验证管理员。');
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('缓存到服务器需要验证管理员身份');
                if (!authorized) return;
            } else {
                return;
            }
        }

        if (!window.SystemDownloadManager) {
            showError('下载管理器未就绪');
            return;
        }

        // 1. 直接将歌曲注册到下载管理器，由其内部调度器控制并发
        const tasks = songsToDownload.map(s => {
            return {
                ...s,
                taskId: 'server_' + (s.id || s.songmid),
                isServer: true,
                quality: targetQuality // 调度器启动时会重新计算最佳音质
            };
        });
        window.SystemDownloadManager.addTasks(tasks);

        if (typeof deselectAll === 'function') deselectAll();
        showInfo(`已将 ${songsToDownload.length} 首歌曲加入缓存队列`);
    }
}

// Re-use helper functions from batch_pagination.js
function getListById(listId) {
    if (!currentListData) return null;
    if (listId === 'default') return currentListData.defaultList;
    if (listId === 'love') return currentListData.loveList;
    const userList = currentListData.userList.find(l => l.id === listId);
    return userList ? userList.list : null;
}

function setListById(listId, newList) {
    if (!currentListData) return;
    if (listId === 'default') currentListData.defaultList = newList;
    else if (listId === 'love') currentListData.loveList = newList;
    else {
        const userList = currentListData.userList.find(l => l.id === listId);
        if (userList) userList.list = newList;
    }
}

// Export functions
window.deleteSingleSong = deleteSingleSong;
window.downloadSong = downloadSong;
window.batchDownloadFromList = batchDownloadFromList;
window.requestServerLyricCache = requestServerLyricCache;

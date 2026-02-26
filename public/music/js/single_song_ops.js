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
                    'x-user-name': username,
                    'x-user-password': password
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

// Placeholder for download function
// Download single song
async function downloadSong(songOrId, forceQuality = null, suppressAlerts = false) {
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

    // Reuse quality selection logic
    const quality = forceQuality || window.QualityManager.getBestQuality(
        song,
        settings.preferredQuality || '320k'
    );

    if (!forceQuality) {
        console.log(`[Download] Start requesting: ${song.name} [${quality}]`);
    }

    try {
        const headers = { 'Content-Type': 'application/json' };
        const authToken = sessionStorage.getItem('lx_player_auth');
        if (authToken) headers['x-user-token'] = authToken;
        if (typeof currentListData !== 'undefined' && currentListData && currentListData.username) {
            headers['x-user-name'] = currentListData.username;
        }

        const res = await fetch(`${API_BASE}/url`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ songInfo: song, quality })
        });

        if (!res.ok) {
            // Try to parse error message
            let errMsg = `HTTP ${res.status}`;
            try {
                const json = await res.json();
                if (json.error) errMsg = json.error;
            } catch { }
            throw new Error(errMsg);
        }

        const result = await res.json();

        if (result.url) {
            let finalUrl = result.url;

            // Check Proxy Download Setting
            let shouldProxyDownload = typeof settings !== 'undefined' && settings.enableProxyDownload;
            if (!shouldProxyDownload && typeof settings !== 'undefined' && settings.enableAutoProxy) {
                if (window.location.protocol === 'https:' && finalUrl.startsWith('http://')) {
                    shouldProxyDownload = true;
                    console.log('[Proxy] 自动代理 HTTP 下载链接');
                }
            }

            if (shouldProxyDownload) {
                // Use server proxy to force download
                // [Fix] Check if URL is already proxied by server to prevent double wrapping
                if (finalUrl.startsWith('/api/music/download')) {
                    // Already proxied, keep as is
                } else {
                    let ext = result.type || 'mp3';
                    if (ext === '128k' || ext === '320k') ext = 'mp3';
                    const filename = `${song.singer} - ${song.name}.${ext}`;
                    finalUrl = `/api/music/download?url=${encodeURIComponent(result.url)}&filename=${encodeURIComponent(filename)}`;
                }
            } else {
                // Proxy disabled: Use direct URL
                console.log('[Download] Proxy disabled, using direct URL.');
            }

            // Create hidden link to trigger download
            const link = document.createElement('a');
            link.href = finalUrl;
            link.target = '_blank';

            // Attempt to set filename (Browser support varies for cross-origin)
            let ext = result.type || 'mp3';
            if (ext === '128k' || ext === '320k') ext = 'mp3';
            link.download = `${song.singer} - ${song.name}.${ext}`;

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            console.log(`[Download] Triggered: ${song.name} [${quality}]`);
            return true;
        } else {
            throw new Error('未获取到下载链接');
        }

    } catch (e) {
        console.error(`[Download] Failed [${quality}]:`, e);

        // Retry logic (Smart Fallback)
        const nextQuality = window.QualityManager.getNextLowerQuality(quality);
        // Only retry if we didn't force a specific quality (unless we want to chain even forced ones, but usually force means "I want this")
        // And ensure we actually have a lower quality to try
        if (nextQuality && !forceQuality) {
            console.log(`[Download] Downgrading to ${nextQuality} and retrying...`);
            // Show a small toast or log to user could be nice, currently using alert only on final failure to avoid spam
            // Show a small toast or log to user could be nice, currently using alert only on final failure to avoid spam
            return await downloadSong(song, nextQuality, suppressAlerts);
        }

        if (!suppressAlerts) showError(`下载失败: ${e.message}\n(已尝试所有可用音质)`);
        return false;
    }
}

// Batch download function
async function batchDownloadFromList() {
    if (selectedItems.size === 0) {
        showError('请先选择要下载的歌曲');
        return;
    }

    if (!(await showSelect('批量下载', `确定要批量下载 ${selectedItems.size} 首歌曲吗？\n(注意：浏览器可能会拦截多个文件的连续下载，请留意地址栏拦截提示)`))) {
        return;
    }

    // Convert IDs to Songs
    const songsToDownload = [];

    // Helper to find song in any array (Loose equality for string/number ID mismatch)
    const findSong = (list, id) => list.find(s => String(s.id) === String(id));

    selectedItems.forEach(id => {
        let song = null;

        // 0. Try explicitly cached song objects (Best for multi-page / search results)
        if (selectedSongObjects && selectedSongObjects.has(id)) {
            song = selectedSongObjects.get(id);
        }

        // 1. Try current playlist (Fallback)
        if (!song && currentPlaylist) {
            song = findSong(currentPlaylist, id);
        }

        // 2. If not found, try all user lists (Global fallback)
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

        if (song) {
            songsToDownload.push(song);
        } else {
            console.warn(`[BatchDownload] Song ID ${id} not found in any known lists.`);
        }
    });

    if (songsToDownload.length === 0) {
        showError('未找到选中歌曲的详细信息');
        console.error('Songs to Download is empty. Selected IDs:', Array.from(selectedItems));
        console.log('Current Playlist:', currentPlaylist);
        return;
    }

    // Create Progress Toast
    const toastId = 'batch-download-toast';
    let toast = document.getElementById(toastId);
    if (!toast) {
        toast = document.createElement('div');
        toast.id = toastId;
        toast.className = 'fixed bottom-24 right-4 bg-emerald-600 text-white px-6 py-3 rounded-lg shadow-lg z-50 transition-all duration-300 flex items-center gap-3 font-medium shadow-emerald-200/50';
        document.body.appendChild(toast);
    }
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    const updateToast = (current, total) => {
        toast.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 正在批量下载: ${current}/${total} 首`;
    };

    // Execute sequentially with delay to be nicer to browsers
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < songsToDownload.length; i++) {
        updateToast(i + 1, songsToDownload.length);

        const song = songsToDownload[i];
        try {
            const result = await downloadSong(song, null, true); // true = suppress alerts
            if (result) successCount++;
            else failCount++;
        } catch (e) {
            console.error(e);
            failCount++;
        }

        // Small delay between requests
        if (i < songsToDownload.length - 1) {
            await new Promise(r => setTimeout(r, 800));
        }
    }

    // Final Status
    toast.className = 'fixed bottom-24 right-4 bg-gray-800 text-white px-6 py-3 rounded-lg shadow-lg z-50 transition-all duration-300 flex items-center gap-3 font-medium';
    toast.innerHTML = successCount === songsToDownload.length
        ? `<i class="fas fa-check-circle text-emerald-400"></i> 下载完成: 共 ${successCount} 首`
        : `<i class="fas fa-info-circle text-yellow-400"></i> 下载结束: ${successCount} 成功, ${failCount} 失败`;

    // Valid timeout to remove
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 4000);
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

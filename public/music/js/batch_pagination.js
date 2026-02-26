// Batch Selection and Deletion Functions
// Batch Selection and Deletion Functions
function handleBatchSelect(songId, isChecked) {
    const id = String(songId); // Force string ID
    if (isChecked) {
        window.selectedItems.add(id);
        // Cache song object if available in viewingPlaylist
        if (typeof viewingPlaylist !== 'undefined' && viewingPlaylist) {
            // Loose comparison just in case, though viewingPlaylist IDs should match render
            const song = window.viewingPlaylist.find(s => String(s.id) === id);
            if (song) window.selectedSongObjects.set(id, song);
        }
    } else {
        window.selectedItems.add(id);
        window.selectedItems.delete(id);
        window.selectedSongObjects.delete(id);
    }
    updateBatchToolbar();
}

function toggleBatchMode() {
    window.batchMode = !window.batchMode;
    window.selectedItems.clear();
    window.selectedSongObjects.clear();

    // Check if song list detail is open
    const slDetail = document.getElementById('songlist-detail-view');
    if (slDetail && !slDetail.classList.contains('hidden')) {
        if (window.SongListManager) window.SongListManager.renderDetail();
    } else {
        renderResults(window.viewingPlaylist);
    }

    updateBatchToolbar();

    const toolbar = document.getElementById('batch-toolbar');
    if (toolbar) {
        toolbar.classList.toggle('hidden', !window.batchMode);
    }

    const slToolbar = document.getElementById('sl-batch-toolbar');
    if (slToolbar) {
        slToolbar.classList.toggle('hidden', !window.batchMode);
    }
}

function selectAllVisible() {
    window.viewingPlaylist.forEach(item => {
        const id = String(item.id);
        window.selectedItems.add(id);
        window.selectedSongObjects.set(id, item);
    });

    const slDetail = document.getElementById('songlist-detail-view');
    if (slDetail && !slDetail.classList.contains('hidden')) {
        if (window.SongListManager) window.SongListManager.renderDetail();
    } else {
        renderResults(window.viewingPlaylist);
    }
    updateBatchToolbar();
}

function deselectAll() {
    window.selectedItems.clear();
    window.selectedSongObjects.clear();

    const slDetail = document.getElementById('songlist-detail-view');
    if (slDetail && !slDetail.classList.contains('hidden')) {
        if (window.SongListManager) window.SongListManager.renderDetail();
    } else {
        renderResults(window.viewingPlaylist);
    }
    updateBatchToolbar();
}

function updateBatchToolbar() {
    const countEl = document.getElementById('batch-selected-count');
    if (countEl) {
        countEl.textContent = window.selectedItems.size;
    }
    const slCountEl = document.getElementById('sl-batch-selected-count');
    if (slCountEl) {
        slCountEl.textContent = window.selectedItems.size;
    }

    const deleteBtn = document.getElementById('batch-delete-btn');
    if (deleteBtn) {
        // Hide delete button in network search mode
        if (window.currentSearchScope === 'network') {
            deleteBtn.classList.add('hidden');
        } else {
            deleteBtn.classList.remove('hidden');
        }
    }
}

async function batchDeleteFromList() {
    if (window.selectedItems.size === 0) {
        showError('请先选择要删除的歌曲');
        return;
    }

    if (!(await showSelect('批量删除', `确定要删除选中的 ${window.selectedItems.size} 首歌曲吗?`, { danger: true }))) {
        return;
    }

    // Get current list context
    const activeListId = getCurrentActiveListId();
    if (!activeListId || !currentListData) {
        showError('无法确定当前列表');
        return;
    }

    const idsToDelete = Array.from(window.selectedItems);

    if (window.SyncManager.mode === 'local') {
        // Local mode: Use user credentials to directly manipulate data
        const username = localStorage.getItem('lx_sync_user');
        const password = localStorage.getItem('lx_sync_pass');

        if (!username || !password) {
            showError('请先登录本地账号');
            return;
        }

        try {
            // Call user-specific API endpoint
            const res = await fetch('/api/music/user/list/remove', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-name': username,
                    'x-user-password': password
                },
                body: JSON.stringify({
                    listId: activeListId,
                    songIds: idsToDelete
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

            console.log('[Batch] 本地模式删除成功');

        } catch (e) {
            showError('批量删除失败: ' + e.message);
            console.error('[Batch] 删除错误:', e);
        }
    } else if (window.SyncManager.mode === 'remote') {
        // Remote mode: Modify cache, sync on next connection
        try {
            // Get current list
            const listToModify = getListById(activeListId);
            if (!listToModify) {
                throw new Error('找不到当前列表');
            }

            // Remove items from list
            const remainingItems = listToModify.filter(item => !idsToDelete.includes(item.id));
            setListById(activeListId, remainingItems);

            // Save to cache
            localStorage.setItem('lx_list_data', JSON.stringify(currentListData));
            console.log('[Batch] WS模式:已修改缓存,下次连接时将同步');

            // If currently connected, push the change immediately
            if (window.SyncManager.client && window.SyncManager.client.isConnected) {
                try {
                    await pushDataChange();
                    console.log('[Batch] WS模式:实时推送成功');
                } catch (e) {
                    console.warn('[Batch] WS推送失败(将在下次连接时同步):', e);
                }
            }

            // Update UI
            renderMyLists(currentListData);
            handleListClick(activeListId);

        } catch (e) {
            showError('批量删除失败: ' + e.message);
            console.error('[Batch] WS删除错误:', e);
        }
    }

    // Clear selection and exit batch mode
    window.selectedItems.clear();
    window.batchMode = false;
    toggleBatchMode(); // Update UI
}

// Helper: Get current active list ID
function getCurrentActiveListId() {
    // From UI context or currentSearchScope
    if (window.currentSearchScope === 'local_list') {
        // Should track which list is being viewed
        return window.currentViewingListId || null;
    }
    return null;
}

// Helper: Get list by ID
function getListById(listId) {
    if (!currentListData) return null;
    if (listId === 'default') return currentListData.defaultList;
    if (listId === 'love') return currentListData.loveList;
    const userList = currentListData.userList.find(l => l.id === listId);
    return userList ? userList.list : null;
}

// Helper: Set list by ID
function setListById(listId, newList) {
    if (!currentListData) return;
    if (listId === 'default') currentListData.defaultList = newList;
    else if (listId === 'love') currentListData.loveList = newList;
    else {
        const userList = currentListData.userList.find(l => l.id === listId);
        if (userList) userList.list = newList;
    }
}

// Pagination Functions
function updatePaginationInfo(start, end, total) {
    const infoEl = document.getElementById('pagination-info');
    if (infoEl) {
        if (total === 0) {
            infoEl.textContent = '无结果';
        } else {
            infoEl.textContent = `显示 ${start}-${end} / 共 ${total} 首`;
        }
    }
}

function goToPage(page) {
    currentPage = page;
    renderResults(window.viewingPlaylist);
}

async function nextPage() {
    const totalItems = window.viewingPlaylist ? window.viewingPlaylist.length : 0;
    const itemsPerPage = settings.itemsPerPage === 'all' ? totalItems : parseInt(settings.itemsPerPage);
    const totalPages = Math.ceil((totalItems || 1) / (itemsPerPage || 1));

    if (currentPage < totalPages) {
        currentPage++;
        renderResults(window.viewingPlaylist);
    } else if (window.currentSearchScope === 'network') {
        const btn = document.querySelector('button[onclick="nextPage()"]');
        const oldHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
            btn.disabled = true;
        }

        try {
            const nextNetPage = (window.currentNetworkPage || 1) + 1;
            await window.doSearch(nextNetPage, true);
        } finally {
            if (btn) {
                btn.innerHTML = oldHtml;
                btn.disabled = false;
            }
        }
    }
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        renderResults(viewingPlaylist);
    }
}

// Settings: Items Per Page
function changeItemsPerPage(value) {
    settings.itemsPerPage = value === 'all' ? 'all' : parseInt(value);
    localStorage.setItem('lx_settings', JSON.stringify(settings));
    currentPage = 1; // Reset to first page
    renderResults(viewingPlaylist);
}

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('lx_settings');
    if (saved) {
        try {
            settings = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }
}

// Export functions to window
window.handleBatchSelect = handleBatchSelect;
window.toggleBatchMode = toggleBatchMode;
window.selectAllVisible = selectAllVisible;
window.deselectAll = deselectAll;
window.batchDeleteFromList = batchDeleteFromList;
window.goToPage = goToPage;
window.nextPage = nextPage;
window.prevPage = prevPage;
window.changeItemsPerPage = changeItemsPerPage;

/**
 * LocalMusicManager (本地音乐模块)
 * 处理在本地音乐Tab下的列表加载、刷选、删除功能
 */

window.LocalMusicManager = {
    originalData: [],
    displayData: [],
    batchMode: false,
    selectedItems: new Set(),
    searchKeyword: '',
    filterFolder: 'all', // all | cache | music
    filterQuality: 'all',
    filterStatus: 'all', // all | missing_id3 | missing_cover | missing_lyric | unindexed
    sortBy: 'mtime',
    sortOrder: 'desc',
    quickSearchKeyword: '',
    searchKeyword: '',
    searchTimer: null,
    isFilterPanelOpen: false,

    init() {
        // Initialization can run when the tab is clicked, or immediately.
        // Try reading global cache location to sync the selector.
        this.syncLocationSelector();
        this.fetchData();

        // Listen to tab switch to trigger refresh if we are on this tab
        const origSwitchTab = window.switchTab;
        window.switchTab = function (tabId) {
            origSwitchTab(tabId);
            if (tabId === 'localmusic') {
                window.LocalMusicManager.syncLocationSelector();
                window.LocalMusicManager.fetchData(true); // silent fetch
            } else {
                // Auto exit batch mode when leaving
                if (window.LocalMusicManager.batchMode) {
                    window.LocalMusicManager.toggleBatchMode();
                }
            }
        };
    },

    syncLocationSelector() {
        // Let's assume 'data' or 'root' based on the config. 
        // We might not have async config sync in UI immediately, but we can read from global.
        // Fallback: we fetch stats or just assume what we get.
        // Setting it via API is the most robust way.
    },

    async changeLocation() {
        const el = document.getElementById('lm-location-select');
        const val = el.value;
        try {
            await fetch('/api/music/cache/config', {
                method: 'POST',
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {},
                body: JSON.stringify({ location: val })
            });
            this.refresh();
        } catch (e) {
            if (typeof showError === 'function') showError('切换目录失败');
        }
    },

    changeFolder() {
        const el = document.getElementById('lm-folder-select');
        this.filterFolder = el.value;
        this.applyFilters();
    },

    toggleUnindexed() {
        const el = document.getElementById('lm-unindexed-filter');
        this.filterUnindexed = el.checked;
        this.applyFilters();
    },

    debounceSearch() {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
            const el = document.getElementById('lm-search-input');
            this.searchKeyword = (el.value || '').trim().toLowerCase();
            this.applyFilters();
        }, 300);
    },

    async refresh() {
        const btn = document.querySelector('button[title="同步并刷新"] i');
        if (btn) btn.classList.add('fa-spin');

        try {
            // First trigger sync on server
            if (typeof showInfo === 'function') showInfo('正在同步物理文件...');
            const syncRes = await fetch('/api/music/cache/sync', {
                method: 'POST',
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}
            });
            const syncResult = await syncRes.json();
            if (!syncResult.success) {
                console.warn('Sync failed:', syncResult.message);
            }
        } catch (e) {
            console.error('Sync request error:', e);
        }

        await this.fetchData();
        if (btn) btn.classList.remove('fa-spin');
    },

    toggleFilterPanel() {
        const panel = document.getElementById('lm-filter-panel');
        const btn = document.getElementById('lm-filter-toggle-btn');
        this.isFilterPanelOpen = !this.isFilterPanelOpen;

        if (this.isFilterPanelOpen) {
            panel.classList.remove('hidden');
            btn.classList.add('t-bg-main', 'shadow-inner');
        } else {
            panel.classList.add('hidden');
            btn.classList.remove('t-bg-main', 'shadow-inner');
        }
    },

    handleQuickSearch(e) {
        this.quickSearchKeyword = (e.target.value || '').trim().toLowerCase();
        this.applyFilters();
    },

    clearFilters() {
        this.searchKeyword = '';
        this.quickSearchKeyword = '';
        this.filterFolder = 'all';
        this.filterQuality = 'all';
        this.filterStatus = 'all';
        this.sortBy = 'mtime';
        this.sortOrder = 'desc';

        document.getElementById('lm-search-input').value = '';
        document.getElementById('lm-quick-search').value = '';
        document.getElementById('lm-quality-select').value = 'all';
        document.getElementById('lm-folder-select').value = 'all';
        document.getElementById('lm-status-select').value = 'all';
        document.getElementById('lm-sort-by').value = 'mtime';
        document.getElementById('lm-sort-order').value = 'desc';

        this.applyFilters();
    },

    async fetchData(silent = false) {
        if (!silent) {
            const container = document.getElementById('lm-list-container');
            if (container) {
                container.innerHTML = `
                    <div class="text-center py-20 text-gray-500 animate-fade-in">
                        <i class="fas fa-circle-notch fa-spin text-4xl mb-4 text-emerald-500"></i>
                        <p class="font-bold tracking-wider">正在加载本地音乐...</p>
                    </div>`;
            }
        }

        try {
            const res = await fetch('/api/music/cache/list', {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}
            });
            const result = await res.json();
            if (result.success) {
                this.originalData = result.data || [];
                // Sort by mtime initially descending
                this.originalData.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
                this.applyFilters();

                // Attempt to auto-sync location switch UI if not selected manually
                // (Only works if we know somehow what the backend uses, but we can ignore for now)
            }
        } catch (err) {
            if (typeof showError === 'function') showError('拉取本地列表失败');
            console.error('LocalMusic Fetch Error:', err);
        }
    },

    applyFilters() {
        let current = this.originalData;

        // 2. Read current filter values
        const searchInput = document.getElementById('lm-search-input');
        if (searchInput) this.searchKeyword = searchInput.value.trim().toLowerCase();

        const qualitySelect = document.getElementById('lm-quality-select');
        if (qualitySelect) this.filterQuality = qualitySelect.value;

        const folderSelect = document.getElementById('lm-folder-select');
        if (folderSelect) this.filterFolder = folderSelect.value;

        const statusSelect = document.getElementById('lm-status-select');
        if (statusSelect) this.filterStatus = statusSelect.value;

        const sortBySelect = document.getElementById('lm-sort-by');
        if (sortBySelect) this.sortBy = sortBySelect.value;
        const sortOrderSelect = document.getElementById('lm-sort-order');
        if (sortOrderSelect) this.sortOrder = sortOrderSelect.value;

        // 3. Apply Filters
        current = current.filter(item => {
            // Folder check
            if (this.filterFolder !== 'all' && item.folder !== this.filterFolder) return false;

            // Quality check
            if (this.filterQuality !== 'all' && item.quality !== this.filterQuality) return false;

            // Metadata Status check
            if (this.filterStatus !== 'all') {
                const isUnindexed = item.source === 'unknown' || (item.songmid && item.songmid.includes(' - '));
                const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';
                const missingID3 = isNoTag(item.name) || isNoTag(item.singer) || isUnindexed;
                const missingCover = !item.hasCover;
                const missingLyric = !item.hasLyric && !item.lyricFilename;

                if (this.filterStatus === 'unindexed' && !isUnindexed) return false;
                if (this.filterStatus === 'missing_id3' && !missingID3) return false;
                if (this.filterStatus === 'missing_cover' && !missingCover) return false;
                if (this.filterStatus === 'missing_lyric' && !missingLyric) return false;
            }

            // Keyword search (Complex)
            const k = this.searchKeyword;
            const qk = this.quickSearchKeyword;

            const matchKeywords = (keyword) => {
                if (!keyword) return true;
                return (item.name || '').toLowerCase().includes(keyword) ||
                    (item.singer || '').toLowerCase().includes(keyword) ||
                    (item.album || '').toLowerCase().includes(keyword) ||
                    (item.filename || '').toLowerCase().includes(keyword);
            };

            if (!matchKeywords(k)) return false;
            if (!matchKeywords(qk)) return false;

            return true;
        });

        // 3.1 Apply Sorting
        current.sort((a, b) => {
            let valA, valB;
            switch (this.sortBy) {
                case 'name':
                    valA = (a.name || a.filename || '').toLowerCase();
                    valB = (b.name || b.filename || '').toLowerCase();
                    break;
                case 'singer':
                    valA = (a.singer || '').toLowerCase();
                    valB = (b.singer || '').toLowerCase();
                    break;
                case 'album':
                    valA = (a.album || '').toLowerCase();
                    valB = (b.album || '').toLowerCase();
                    break;
                case 'source':
                    valA = (a.source || '').toLowerCase();
                    valB = (b.source || '').toLowerCase();
                    break;
                case 'size':
                    valA = a.size || 0;
                    valB = b.size || 0;
                    break;
                case 'mtime':
                default:
                    valA = a.mtime || 0;
                    valB = b.mtime || 0;
                    break;
            }

            if (valA < valB) return this.sortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        // 4. Update UI Indicator
        const dot = document.getElementById('lm-filter-active-dot');
        const hasActiveFilters = this.searchKeyword || this.filterQuality !== 'all' || this.filterFolder !== 'all' || this.filterStatus !== 'all';
        if (dot) {
            if (hasActiveFilters) dot.classList.remove('hidden');
            else dot.classList.add('hidden');
        }

        const countEl = document.getElementById('lm-total-count');
        if (countEl) countEl.innerText = `共 ${current.length} 首`;

        this.displayData = current;

        // Clean up selected items that are no longer in display
        const displayIdentifiers = new Set(this.displayData.map(i => i.filename));
        for (const sel of this.selectedItems) {
            if (!displayIdentifiers.has(sel)) {
                this.selectedItems.delete(sel);
            }
        }
        this.updateBatchUI();

        this.render();
    },

    render() {
        const container = document.getElementById('lm-list-container');
        if (!container) return;

        if (this.displayData.length === 0) {
            container.innerHTML = `
                <div class="text-center py-20 text-gray-500">
                    <i class="fas fa-inbox text-4xl mb-4 opacity-50"></i>
                    <p>没有找到相关本地音乐</p>
                </div>`;
            return;
        }

        const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';

        let html = '';
        this.displayData.forEach((item, index) => {
            const isUnindexed = item.source === 'unknown' || (item.songmid && item.songmid.includes(' - '));
            const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';
            const missingID3 = isNoTag(item.name) || isNoTag(item.singer) || isUnindexed;
            const missingCover = !item.hasCover;
            const missingLyric = !item.hasLyric && !item.lyricFilename;

            const isSelected = this.selectedItems.has(item.filename);
            const qualityClass = window.QualityManager && window.QualityManager.getQualityColor ? window.QualityManager.getQualityColor(item.quality) : 'bg-gray-100 text-gray-600';
            const qualityName = window.QualityManager ? window.QualityManager.getQualityDisplayName(item.quality) : item.quality;

            let coverHtml = `<div class="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-gray-100/50 flex-shrink-0 flex items-center justify-center border t-border-main mr-3 md:mr-4 ml-1 md:ml-3">
                                <i class="fas fa-music t-text-muted text-xs"></i>
                             </div>`;
            if (item.hasCover) {
                const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';
                const coverUrl = `/api/music/cache/cover?filename=${encodeURIComponent(item.filename)}&user=${encodeURIComponent(username)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}&t=${Date.now()}`;
                coverHtml = `<img src="${coverUrl}" onerror="this.src='/music/assets/logo.svg'" loading="lazy" class="w-10 h-10 md:w-12 md:h-12 rounded-lg object-cover shadow-sm flex-shrink-0 border t-border-main mr-3 md:mr-4 ml-1 md:ml-3">`;
            }

            const formatSize = (bytes) => {
                if (!bytes) return '--';
                return (bytes / 1024 / 1024).toFixed(1) + 'M';
            };

            const formatTime = (ts) => {
                if (!ts) return '';
                const d = new Date(ts);
                return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
            };

            const folderIcon = item.folder === 'music' ? '<i class="fas fa-download text-blue-500 mr-1" title="下载目录"></i>' : '<i class="fas fa-hdd text-emerald-500 mr-1" title="缓存目录"></i>';

            html += `
            <div class="grid grid-cols-12 gap-2 md:gap-4 p-2 items-center rounded-xl hover:t-bg-item-hover transition-all t-border-main border-b last:border-b-0 group relative ${isSelected ? 't-bg-item-hover ring-1 ring-emerald-500/30' : ''}" data-lm-filename="${item.filename}">
                <!-- # / Batch -->
                <div class="col-span-1 text-center text-xs font-mono t-text-muted flex-shrink-0 flex items-center justify-center">
                    <div class="${this.batchMode ? 'hidden' : 'block'}">${index + 1}</div>
                    <div class="${this.batchMode ? 'block' : 'hidden'}">
                        <label class="flex items-center justify-center w-full h-full cursor-pointer">
                            <input type="checkbox" onchange="window.LocalMusicManager.toggleSelect('${item.filename.replace(/'/g, "\\'")}', this.checked)" ${isSelected ? 'checked' : ''}
                                class="w-4 h-4 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500 mx-auto cursor-pointer transition-all">
                        </label>
                    </div>
                </div>

                <!-- Song & Cover -->
                <div class="col-span-8 sm:col-span-5 md:col-span-4 lg:col-span-4 flex items-center min-w-0 pr-2">
                    ${coverHtml}
                    <div class="min-w-0 flex-1 truncate">
                        <div class="font-bold text-sm md:text-base t-text-main truncate group-hover:text-emerald-500 transition-colors cursor-pointer" onclick="window.LocalMusicManager.playItem(${index})">
                            ${item.name || '未知歌曲'}
                        </div>
                        <div class="text-[10px] md:text-xs t-text-muted mt-0.5 truncate flex items-center gap-1.5 flex-wrap">
                            <span class="px-1.5 py-[1px] rounded-md border t-border-main ${qualityClass} scale-90 origin-left inline-block">${qualityName || '标准'}</span>
                            ${item.bitrate ? `<span class="text-[10px] opacity-60 font-mono">${Math.round(item.bitrate)}kbps</span>` : ''}
                            ${item.sampleRate ? `<span class="text-[10px] opacity-60 font-mono">${(item.sampleRate / 1000).toFixed(1)}kHz</span>` : ''}
                            ${item.bitDepth && item.bitDepth > 16 ? `<span class="text-[10px] opacity-60 font-mono">${item.bitDepth}bit</span>` : ''}
                            ${item.hasLyric || item.lyricFilename ? '<span class="text-[10px] text-emerald-500 border border-emerald-500/30 rounded px-1 scale-90">词</span>' : ''}
                            ${item.hasCover ? '<span class="text-[10px] text-emerald-500 border border-emerald-500/30 rounded px-1 scale-90">封</span>' : ''}
                        </div>
                    </div>
                </div>

                <!-- Singer -->
                <div class="hidden sm:block sm:col-span-4 md:col-span-3 lg:col-span-2 text-xs t-text-main truncate pr-2">
                    ${item.singer || '未知歌手'}
                </div>

                <!-- Album -->
                <div class="hidden lg:block lg:col-span-2 text-xs t-text-muted truncate pr-2">
                    ${item.album || '--'}
                </div>

                <!-- Source/Info with Metadata Status -->
                <div class="hidden md:flex flex-col md:col-span-2 lg:col-span-1 text-xs t-text-muted pr-2">
                    <div class="flex items-center gap-1 mb-1">
                        ${folderIcon}
                        <span class="truncate font-medium">${item.source === 'unknown' ? '未知' : item.source}</span>
                    </div>
                    <div class="flex flex-wrap gap-1">
                        ${missingID3 ? '<span class="px-1 py-0 bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded text-[9px] font-bold">缺标签</span>' : ''}
                        ${missingCover ? '<span class="px-1 py-0 bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400 rounded text-[9px] font-bold">缺封面</span>' : ''}
                        ${missingLyric ? '<span class="px-1 py-0 bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400 rounded text-[9px] font-bold">缺词</span>' : ''}
                        ${(!missingID3 && !missingCover && !missingLyric) ? '<span class="px-1 py-0 bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 rounded text-[9px] font-bold">完整</span>' : ''}
                    </div>
                    <div class="text-[9px] mt-1 opacity-70 scale-90 origin-left">${formatTime(item.mtime)}</div>
                </div>

                <!-- Action Button -->
                <div class="col-span-3 sm:col-span-2 md:col-span-2 lg:col-span-2 flex items-center justify-end gap-1 sm:gap-2">
                    <div class="hidden lg:block text-xs text-right pr-2 font-mono t-text-muted shrink-0 mr-1">
                        ${formatSize(item.size)}
                    </div>
                    ${isUnindexed ? `
                        <button onclick="window.LocalMusicManager.openManualIndexModal(${index})"
                                class="w-7 h-7 flex items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition-all shadow-sm shrink-0" title="手动关联">
                            <i class="fas fa-link text-[10px]"></i>
                        </button>
                    ` : ''}
                    <button onclick="window.LocalMusicManager.playItem(${index})"
                            class="w-7 h-7 flex items-center justify-center rounded-full t-bg-main border t-border-main t-text-main hover:text-emerald-500 hover:border-emerald-300 transition-all shadow-sm shrink-0" title="播放">
                        <i class="fas fa-play text-[10px] ml-0.5"></i>
                    </button>
                    <!-- Download -->
                    <button onclick="window.LocalMusicManager.downloadSingle(${index})"
                            class="w-7 h-7 flex items-center justify-center rounded-full t-bg-main border t-border-main t-text-main hover:text-blue-500 hover:border-blue-300 transition-all shadow-sm shrink-0" title="保存到设备">
                        <i class="fas fa-download text-[10px]"></i>
                    </button>
                    <!-- Deletion from single operations -->
                    <button onclick="window.LocalMusicManager.deleteSingle('${item.filename.replace(/'/g, "\\'")}')"
                            class="w-7 h-7 flex items-center justify-center rounded-full t-bg-main border t-border-main t-text-muted hover:text-red-500 hover:border-red-300 transition-all shadow-sm shrink-0" title="删除">
                        <i class="far fa-trash-alt text-[10px]"></i>
                    </button>
                </div>
            </div>
            `;
        });

        container.innerHTML = html;
    },

    toggleSelect(filename, checked) {
        if (checked) {
            this.selectedItems.add(filename);
        } else {
            this.selectedItems.delete(filename);
        }

        // Update DOM visually immediately if possible
        const row = document.querySelector(`[data-lm-filename="${filename}"]`);
        if (row) {
            if (checked) {
                row.classList.add('t-bg-item-hover', 'ring-1', 'ring-emerald-500/30');
            } else {
                row.classList.remove('t-bg-item-hover', 'ring-1', 'ring-emerald-500/30');
            }
        }

        this.updateBatchUI();
    },

    toggleBatchMode() {
        this.batchMode = !this.batchMode;
        if (!this.batchMode) {
            this.selectedItems.clear();
        }

        const tb = document.getElementById('lm-batch-toolbar');
        if (tb) {
            if (this.batchMode) {
                tb.classList.remove('hidden');
                tb.classList.add('flex');
            } else {
                tb.classList.add('hidden');
                tb.classList.remove('flex');
            }
        }

        this.updateBatchUI();
        this.render(); // Re-render to show/hide checkboxes globally
    },

    selectAll() {
        this.displayData.forEach(item => this.selectedItems.add(item.filename));
        this.updateBatchUI();
        this.render();
    },

    deselectAll() {
        this.selectedItems.clear();
        this.updateBatchUI();
        this.render();
    },

    updateBatchUI() {
        const span = document.getElementById('lm-batch-selected-count');
        if (span) span.textContent = this.selectedItems.size;
    },

    playItem(index) {
        const item = this.displayData[index];
        if (!item) return;

        // Transform into songInfo for global player
        const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';
        const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';

        // Important: Use existing checkCache via global logic if possible, 
        // or directly supply local URL
        const songInfo = {
            ...item.songInfo,
            // Reconstruct full URL locally
            url: `/api/music/cache/file/${encodeURIComponent(username)}/${encodeURIComponent(item.filename)}?folder=${item.folder}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}`,
            pic: `/api/music/cache/cover?filename=${encodeURIComponent(item.filename)}&user=${encodeURIComponent(username)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}&t=${Date.now()}`,
            isLocal: true,
            folder: item.folder
        };

        // If 'app.js' exposes playSong(song), we use it.
        // We might want to construct a playlist of local tracks.
        const playlist = this.displayData.map(d => ({
            ...d.songInfo,
            url: `/api/music/cache/file/${encodeURIComponent(username)}/${encodeURIComponent(d.filename)}?folder=${d.folder}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}`,
            pic: `/api/music/cache/cover?filename=${encodeURIComponent(d.filename)}&user=${encodeURIComponent(username)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}&t=${Date.now()}`,
            isLocal: true
        }));

        if (typeof window.updatePlaylist === 'function') {
            window.updatePlaylist(playlist, index, 'local_all');
        } else if (typeof window.playSong === 'function') {
            // Fallback for older versions
            window.playSong(songInfo, index);
        } else {
            console.error('Playback functions are not defined globally.');
        }
    },

    async deleteSingle(filename) {
        if (typeof showSelect === 'function') {
            if (!(await showSelect('删除本地文件', '确定要删除此文件吗?', { danger: true }))) return;
        } else {
            if (!confirm('确定要删除此文件吗?')) return;
        }
        this._executeDelete([filename]);
    },

    async batchDelete() {
        if (this.selectedItems.size === 0) {
            if (typeof showError === 'function') showError('请先选择要删除的文件');
            return;
        }
        if (typeof showSelect === 'function') {
            if (!(await showSelect('删除本地文件', `确定要批量删除这 ${this.selectedItems.size} 个文件吗?`, { danger: true }))) return;
        } else {
            if (!confirm(`确定要删除 ${this.selectedItems.size} 个文件吗?`)) return;
        }
        this._executeDelete(Array.from(this.selectedItems));
    },

    async _executeDelete(filenames) {
        try {
            const res = await fetch('/api/music/cache/remove', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames })
            });
            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo(`成功删除了 ${result.deletedCount || filenames.length} 个文件`);
                // Clear selection
                for (const f of filenames) this.selectedItems.delete(f);
                this.updateBatchUI();
                await this.refresh();
            } else {
                throw new Error(result.message || 'Server returned error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('删除失败: ' + e.message);
            console.error('Delete error:', e);
        }
    },

    async batchFetchLyrics() {
        // Find items that don't have lyrics
        const targetFilenames = Array.from(this.selectedItems);
        const targets = this.displayData.filter(i => targetFilenames.includes(i.filename) && !i.hasLyric);

        if (targets.length === 0) {
            if (typeof showInfo === 'function') showInfo('选中的歌曲中没有需要补充歌词的项');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('补全歌词', `选中的文件中有 ${targets.length} 首没有对应的歌词，确定要向服务器请求补全吗?`))) return;
        }

        let success = 0;
        let fail = 0;

        for (const item of targets) {
            if (!item.songInfo || !item.songInfo.source || item.songInfo.source === 'unknown') {
                fail++;
                continue;
            }
            try {
                // If single_song_ops exposes requestServerLyricCache
                if (typeof window.requestServerLyricCache === 'function') {
                    await window.requestServerLyricCache(item.songInfo, item.quality, true);
                    success++;
                } else {
                    fail++;
                }
            } catch (e) {
                fail++;
            }
        }

        if (typeof showInfo === 'function') {
            showInfo(`补全操作完成。成功 ${success} 项，失败/不支持 ${fail} 项`);
        }
        this.refresh();
    },

    async batchUpdateMetadata() {
        const targetFilenames = Array.from(this.selectedItems);
        const targets = this.displayData.filter(i => targetFilenames.includes(i.filename));

        if (targets.length === 0) {
            if (typeof showInfo === 'function') showInfo('请先选择需要补全元信息的文件');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('补全元信息', `确定要向服务器请求补全这 ${targets.length} 个文件的元信息(包含封面与ID3标签)吗?`))) return;
        } else {
            if (!confirm(`确定要补全这 ${targets.length} 个文件的元信息吗?`)) return;
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在处理，请稍候...');
            const res = await fetch('/api/music/cache/updateMetadata', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames: targetFilenames })
            });

            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo(`元信息补全完成。成功 ${result.successCount} 项，失败 ${result.failCount} 项`);
                this.refresh();
            } else {
                throw new Error(result.message || 'Server returned error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('补全元信息失败: ' + e.message);
        }
    },

    async batchSwitchFolder() {
        const targetFilenames = Array.from(this.selectedItems);
        if (targetFilenames.length === 0) {
            if (typeof showError === 'function') showError('请先选择要移动的文件');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('移动目录', `确定要将选中的 ${targetFilenames.length} 个文件在 下载目录 与 缓存目录 之间互相转移吗?`))) return;
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在移动文件，请稍候...');
            const res = await fetch('/api/music/cache/move', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames: targetFilenames })
            });

            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo(`目录转移完成。成功 ${result.successCount} 项，失败 ${result.failCount} 项`);
                this.deselectAll();
                this.refresh();
            } else {
                throw new Error(result.message || 'Server returned error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('移动失败: ' + e.message);
        }
    },

    async batchSwitchBaseLocation() {
        const targetFilenames = Array.from(this.selectedItems);
        if (targetFilenames.length === 0) {
            if (typeof showError === 'function') showError('请先选择要转移的文件');
            return;
        }

        const el = document.getElementById('lm-location-select');
        const currentLocName = el ? (el.value === 'data' ? '云端(Data)' : '本地(Root)') : '当前目录';
        const targetLocName = el ? (el.value === 'data' ? '本地(Root)' : '云端(Data)') : '另一目录';

        if (typeof showSelect === 'function') {
            if (!(await showSelect('云端同步', `确定要将选中的 ${targetFilenames.length} 个文件从 ${currentLocName} 转移到 ${targetLocName} 吗?`))) return;
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在跨目录转移文件，请稍候...');
            const res = await fetch('/api/music/cache/switch-base', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames: targetFilenames })
            });

            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo(`跨目录转移完成。成功 ${result.successCount} 项，失败 ${result.failCount} 项`);
                this.deselectAll();
                this.refresh();
            } else {
                throw new Error(result.message || 'Server returned error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('转移失败: ' + e.message);
        }
    },



    downloadSingle(index) {
        const item = this.displayData[index];
        if (!item) return;
        const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';
        const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';
        const url = `/api/music/cache/file/${encodeURIComponent(username)}/${encodeURIComponent(item.filename)}?folder=${item.folder}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}`;

        const a = document.createElement('a');
        a.href = url;
        a.download = item.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    },

    batchDownloadToDevice() {
        const targetFilenames = Array.from(this.selectedItems);
        const targets = this.displayData.filter(i => targetFilenames.includes(i.filename));

        if (targets.length === 0) {
            if (typeof showError === 'function') showError('请先选择要保存的文件');
            return;
        }

        const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';
        const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';

        // Use a slight delay to prevent browser from blocking multiple downloads
        targets.forEach((item, idx) => {
            setTimeout(() => {
                const url = `/api/music/cache/file/${encodeURIComponent(username)}/${encodeURIComponent(item.filename)}?folder=${item.folder}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}`;
                const a = document.createElement('a');
                a.href = url;
                a.download = item.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }, idx * 500);
        });

        if (typeof showInfo === 'function') showInfo(`已开始下载 ${targets.length} 个文件到设备`);
        this.deselectAll();
    },

    async openManualIndexModal(index) {
        console.log('[ManualIndex] Opening modal for index:', index);
        const item = this.displayData[index];
        if (!item) {
            console.error('[ManualIndex] Item not found at index:', index);
            return;
        }

        this.manualIndexTargetItem = item;
        const modal = document.getElementById('modal-manual-index');
        const content = document.getElementById('modal-manual-index-content');
        const input = document.getElementById('manual-index-search-input');
        const filenameEl = document.getElementById('manual-index-target-filename');
        const durationEl = document.getElementById('manual-index-target-duration');

        if (filenameEl) filenameEl.textContent = item.filename;
        if (durationEl) durationEl.textContent = item.interval || '--:--';

        // 默认搜索词：优先使用已有标签，否则使用文件名
        let defaultSearch = '';
        const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';

        if (!isNoTag(item.name)) defaultSearch += item.name;
        if (!isNoTag(item.singer)) defaultSearch += ' ' + item.singer;

        if (!defaultSearch.trim()) {
            defaultSearch = item.filename.replace(/\.[^/.]+$/, "").replace(/_-_/g, " ").replace(/ - /g, " ");
        }

        if (input) {
            input.value = defaultSearch.trim();
        }

        if (modal) {
            console.log('[ManualIndex] Modifying modal styles for visibility');
            // 确保移除所有可能导致残留隐藏的属性
            modal.classList.remove('hidden');
            modal.style.setProperty('display', 'flex', 'important');
            modal.style.setProperty('z-index', '9999', 'important');
            modal.style.setProperty('opacity', '1', 'important');

            setTimeout(() => {
                if (content) {
                    content.classList.remove('scale-95', 'opacity-0');
                    content.classList.add('scale-100', 'opacity-100');
                    content.style.opacity = '1';
                    content.style.transform = 'scale(1)';
                }
                if (input) input.focus();
            }, 50);
        } else {
            console.error('[ManualIndex] Modal element not found!');
        }

        if (input && input.value) {
            this.doManualSearch();
        }
    },

    closeManualIndexModal() {
        const modal = document.getElementById('modal-manual-index');
        const content = document.getElementById('modal-manual-index-content');
        if (content) {
            content.classList.add('scale-95', 'opacity-0');
            content.classList.remove('scale-100', 'opacity-100');
        }
        setTimeout(() => {
            if (modal) {
                modal.classList.add('hidden');
                modal.style.display = 'none';
            }
            const resultsContainer = document.getElementById('manual-index-results');
            if (resultsContainer) {
                resultsContainer.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full opacity-30 mt-10">
                        <i class="fas fa-magnifying-glass text-6xl mb-4"></i>
                        <p class="text-sm font-bold tracking-wider">搜索在线歌曲以建立关联</p>
                    </div>`;
            }
            this.manualIndexTargetItem = null;
            this.currentManualResults = [];

            // Reset identify button
            const btn = document.getElementById('btn-manual-identify');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-fingerprint text-xl"></i>';
                btn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }, 300);
    },

    async identifyTargetSong() {
        const item = this.manualIndexTargetItem;
        if (!item) return;

        const btn = document.getElementById('btn-manual-identify');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-circle-notch fa-spin text-xl"></i>';
            btn.classList.add('opacity-50', 'cursor-not-allowed');
        }

        try {
            const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';
            const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';

            const resp = await fetch('/api/music/identify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-name': username,
                    'x-user-token': authToken
                },
                body: JSON.stringify({ filename: item.filename, folder: item.folder })
            });

            const result = await resp.json();
            if (result.success && result.results && result.results.length > 0) {
                const bestMatch = result.results[0];
                const searchInput = document.getElementById('manual-index-search-input');
                if (searchInput) {
                    searchInput.value = `${bestMatch.singer} - ${bestMatch.name}`;
                    // Trigger search
                    this.doManualSearch();
                }
                const scorePct = Math.round(bestMatch.score * 100);
                if (typeof showInfo === 'function') showInfo(`特征识别成功: ${bestMatch.singer} - ${bestMatch.name} (置信度: ${scorePct}%)`);
            } else {
                if (typeof showInfo === 'function') showInfo('无法识别该歌曲特征');
            }
        } catch (e) {
            console.error('[Identify] Failed:', e);
            if (typeof showInfo === 'function') showInfo('识别失败: ' + e.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-fingerprint text-xl"></i>';
                btn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    },

    async doManualSearch() {
        const input = document.getElementById('manual-index-search-input');
        const keyword = input ? input.value.trim() : '';
        const sourceEl = document.getElementById('manual-index-source-select');
        const source = (sourceEl ? sourceEl.value : '') || 'tx';
        const container = document.getElementById('manual-index-results');
        const btn = document.getElementById('btn-do-manual-search');

        if (!keyword) return;

        const origBtnHtml = btn ? btn.innerHTML : '搜索';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
        }

        console.log('[ManualIndex] Searching for:', keyword, 'on source:', source);

        if (container) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full py-20 animate-fade-in">
                    <div class="music-visualizer-loader mb-12">
                        <div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div>
                    </div>
                    <div class="text-center">
                        <p class="text-xl t-text-main font-black tracking-[0.2em] mb-2 uppercase">Searching ${source}</p>
                        <div class="flex items-center justify-center gap-2 text-emerald-500 font-bold mb-4">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
                            <span class="text-sm">正在请求线路</span>
                        </div>
                        <p class="text-xs t-text-muted opacity-60">请稍候，服务器正在同步搜索结果...</p>
                    </div>
                </div>`;
        }

        try {
            // 注意：API 期望的是 name 参数而不是 word
            const url = `/api/music/search?name=${encodeURIComponent(keyword)}&source=${source}&page=1`;
            const res = await fetch(url, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || `Status: ${res.status}`);
            }

            const result = await res.json();

            // 适配两种可能的返回结构：{success, data: {list}} 或 直接返回数组
            let searchList = [];
            if (Array.isArray(result)) {
                searchList = result;
            } else if (result.success && result.data && result.data.list) {
                searchList = result.data.list;
            } else if (result.list) {
                searchList = result.list;
            }

            if (searchList && searchList.length > 0) {
                this.currentManualResults = searchList;
                this.renderManualSearchResults(this.currentManualResults);
            } else {
                if (container) container.innerHTML = `<div class="text-center py-20 opacity-50 font-bold">未找到相关结果</div>`;
            }
        } catch (e) {
            console.error('[ManualIndex] Search failed:', e);
            if (container) container.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">搜索失败: ${e.message}</div>`;
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origBtnHtml;
            }
        }
    },

    renderManualSearchResults(results) {
        const container = document.getElementById('manual-index-results');
        if (!container || !this.manualIndexTargetItem) return;

        const targetInterval = this.manualIndexTargetItem.interval;
        const targetSecs = this.parseInterval(targetInterval);

        // 排序逻辑：时长匹配的排在前面
        const sortedResults = [...results].sort((a, b) => {
            const aSecs = this.parseInterval(a.interval);
            const bSecs = this.parseInterval(b.interval);
            const aDiff = targetSecs > 0 ? Math.abs(aSecs - targetSecs) : 999;
            const bDiff = targetSecs > 0 ? Math.abs(bSecs - targetSecs) : 999;

            if (aDiff <= 3 && bDiff > 3) return -1;
            if (bDiff <= 3 && aDiff > 3) return 1;
            return 0;
        });

        let html = '';
        sortedResults.forEach((item) => {
            const itemSecs = this.parseInterval(item.interval);
            const isMatch = targetSecs > 0 && Math.abs(itemSecs - targetSecs) <= 3;

            // 找到原始索引
            const originalIdx = results.findIndex(r => r === item);

            html += `
                <div class="flex items-center p-4 t-bg-main border t-border-main rounded-3xl hover:border-emerald-400 group transition-all shadow-sm">
                    <div class="w-12 h-12 rounded-xl overflow-hidden mr-4 flex-shrink-0 bg-gray-100 border t-border-main">
                        <img src="${item.img || '/music/assets/logo.svg'}" onerror="this.src='/music/assets/logo.svg'" loading="lazy" class="w-full h-full object-cover">
                    </div>
                    <div class="flex-1 min-w-0 mr-4">
                        <div class="font-bold t-text-main text-sm md:text-base truncate group-hover:text-emerald-500 transition-colors">${item.name}</div>
                        <div class="text-[11px] t-text-muted truncate mt-0.5 font-medium">${item.singer} · ${item.albumName || '未知专辑'}</div>
                    </div>
                    <div class="text-right mr-5 flex-shrink-0">
                        <div class="text-[10px] uppercase font-black t-text-muted opacity-30 tracking-widest mb-0.5">${item.source}</div>
                        <div class="text-[11px] font-mono font-bold ${isMatch ? 'text-emerald-500 bg-emerald-50 px-1.5 py-0.5 rounded-lg' : 't-text-main'}">${item.interval || '--:--'}</div>
                    </div>
                    <button onclick="window.LocalMusicManager.linkItem(${originalIdx})"
                        class="px-6 py-2.5 ${isMatch ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-emerald-500/20' : 't-bg-track hover:t-bg-item-hover t-text-main border t-border-main'} font-bold text-xs rounded-xl shadow-lg transition-all active:scale-95">
                        关联
                    </button>
                </div>
            `;
        });

        container.innerHTML = html || `<div class="text-center py-20 opacity-50 font-bold">未找到搜索结果</div>`;
    },

    async linkItem(idx) {
        if (!this.manualIndexTargetItem || !this.currentManualResults || !this.currentManualResults[idx]) return;

        const onlineItem = this.currentManualResults[idx];
        const targetSecs = this.parseInterval(this.manualIndexTargetItem.interval);
        const itemSecs = this.parseInterval(onlineItem.interval);
        const isMatch = targetSecs > 0 && Math.abs(itemSecs - targetSecs) <= 3;

        if (!isMatch && targetSecs > 0) {
            if (typeof showSelect === 'function') {
                if (!(await showSelect('时长不匹配', `选中的歌曲时长 (${onlineItem.interval}) 与本地文件 (${this.manualIndexTargetItem.interval}) 相差较大，确定要强制关联吗?`))) return;
            } else {
                if (!confirm('时长不匹配，确定要关联吗?')) return;
            }
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在关联并同步元数据...');
            const res = await fetch('/api/music/cache/link', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({
                    filename: this.manualIndexTargetItem.filename,
                    songInfo: onlineItem
                })
            });

            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo('关联成功！文件名及标签已更新');
                this.closeManualIndexModal();
                this.refresh();
            } else {
                throw new Error(result.message || 'Server error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('关联操作失败: ' + e.message);
        }
    },

    async autoLinkAll() {
        const unindexed = this.originalData.filter(item =>
            item.source === 'unknown' || (item.songmid && item.songmid.includes(' - ')) || !item.name || item.name === '未知歌曲'
        );

        if (unindexed.length === 0) {
            if (typeof showInfo === 'function') showInfo('所有歌曲已关联，无需自动处理');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('自动关联', `共发现 ${unindexed.length} 首未关联歌曲，系统将尝试通过多源搜索并匹配时长（误差±2s内）进行自动识别，确定开始吗？`))) return;
        }

        let successCount = 0;
        let failCount = 0;
        const total = unindexed.length;

        for (let i = 0; i < total; i++) {
            const item = unindexed[i];
            if (typeof showInfo === 'function') showInfo(`正在自动识别 (${i + 1}/${total}): ${item.name || item.filename}`);

            const match = await this.findBestMatch(item);
            if (match) {
                try {
                    const res = await fetch('/api/music/cache/link', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                        },
                        body: JSON.stringify({
                            filename: item.filename,
                            songInfo: match
                        })
                    });
                    const result = await res.json();
                    if (result.success) {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } catch (e) {
                    failCount++;
                }
            } else {
                failCount++;
            }
        }

        if (typeof showSelect === 'function') {
            await showSelect('自动关联完成', `成功关联: ${successCount} 首\n未能识别: ${failCount} 首\n未识别歌曲建议手动关联。`, { okOnly: true });
        } else {
            alert(`自动关联完成！\n成功: ${successCount}\n失败: ${failCount}`);
        }
        this.refresh();
    },

    async findBestMatch(localItem) {
        const sources = ['tx', 'wy', 'kg', 'kw', 'mg'];
        const targetSecs = this.parseInterval(localItem.interval);
        if (targetSecs <= 0) return null;

        // 1. 优先：使用 AcoustID 指纹识别
        console.log('[AutoLink] Using AcoustID first for:', localItem.filename);
        try {
            const username = (window.currentListData && window.currentListData.username) || localStorage.getItem('lx_sync_user') || '_open';
            const authToken = (window.getUserAuthHeaders ? window.getUserAuthHeaders()['x-user-token'] : null) || localStorage.getItem('lx_user_token') || '';

            const resp = await fetch('/api/music/identify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-name': username,
                    'x-user-token': authToken
                },
                body: JSON.stringify({ filename: localItem.filename, folder: localItem.folder })
            });

            const result = await resp.json();
            if (result.success && result.results && result.results.length > 0) {
                const bestIdentify = result.results[0];
                const scorePct = Math.round(bestIdentify.score * 100);
                if (typeof showInfo === 'function') showInfo(`[指纹识别] ${bestIdentify.singer} - ${bestIdentify.name} (${scorePct}%)`);

                // 使用识别出的信息再次在各源中搜索以获取规范的 songInfo
                const identifyKeyword = `${bestIdentify.singer} ${bestIdentify.name}`;
                for (const source of sources) {
                    const results = await this.searchSingleSource(identifyKeyword, source);
                    const match = results.find(r => {
                        const rSecs = this.parseInterval(r.interval);
                        return Math.abs(rSecs - targetSecs) <= 3;
                    });
                    if (match) return match;
                }
            }
        } catch (e) {
            console.error('[AutoLink] AcoustID indentify failed:', e);
        }

        // 2. 兜底：关键词搜索
        // Try to get clean keywords
        let keyword = localItem.name;
        const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';

        if (isNoTag(keyword)) {
            keyword = localItem.filename.replace(/\.[^/.]+$/, "").replace(/^[0-9\-_\s]+/, "");
        } else if (localItem.singer && !isNoTag(localItem.singer)) {
            keyword = `${localItem.name} ${localItem.singer}`;
        }

        console.log('[AutoLink] Falling back to keyword search:', keyword);
        for (const source of sources) {
            try {
                const results = await this.searchSingleSource(keyword, source);
                if (results && results.length > 0) {
                    // Look for precise duration match
                    const match = results.find(r => {
                        const rSecs = this.parseInterval(r.interval);
                        return Math.abs(rSecs - targetSecs) <= 2;
                    });
                    if (match) return match;
                }
            } catch (e) {
                console.warn(`Search failed for ${source}:`, e);
            }
        }

        return null;
    },

    async searchSingleSource(text, source) {
        try {
            const res = await fetch(`/api/music/search?name=${encodeURIComponent(text)}&source=${source}&page=1&limit=10`, {
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}
            });
            const result = await res.json();

            // Normalize result format (supporting array or object)
            if (Array.isArray(result)) return result;
            if (result.list && Array.isArray(result.list)) return result.list;
            if (result.data && result.data.list) return result.data.list;
            return [];
        } catch (e) {
            return [];
        }
    },

    parseInterval(str) {
        if (!str) return 0;
        if (typeof str === 'number') return str;
        const pts = str.split(':');
        if (pts.length === 2) return parseInt(pts[0]) * 60 + parseInt(pts[1]);
        if (pts.length === 3) return parseInt(pts[0]) * 3600 + parseInt(pts[1]) * 60 + parseInt(pts[2]);
        return parseInt(str) || 0;
    }
};

window.toggleLmBatchMode = () => window.LocalMusicManager.toggleBatchMode();

// Auto init when script loads (if in scope), else done manually
setTimeout(() => {
    if (window.LocalMusicManager) {
        window.LocalMusicManager.init();
    }
}, 500);

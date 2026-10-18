// ==UserScript==
// @name         学习通自动刷课脚本 v4
// @namespace    local.codex.xuexitong
// @version      4.4.2
// @description  自动播放、自动切换下一节；多视频依次播完再跳转；跳过已完成任务点；跳过名字含测试/测验的小节
// @author       Codex
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    const APP_KEY = '__xuexitongPlayerV3';
    const BOOT_TIMER_KEY = '__xuexitongPlayerV3BootTimer';

    const previousApp = window[APP_KEY];
    if (previousApp && typeof previousApp.destroy === 'function') {
        previousApp.destroy();
    }
    if (window[BOOT_TIMER_KEY]) {
        clearInterval(window[BOOT_TIMER_KEY]);
        window[BOOT_TIMER_KEY] = null;
    }

    if (typeof window.jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        script.type = 'text/javascript';
        script.onload = function () {
            console.log("jQuery loaded.");
            waitForCoursePage();
        };
        document.head.appendChild(script);
    } else {
        waitForCoursePage();
    }

    function waitForCoursePage() {
        let attempts = 0;
        const maxAttempts = 20;
        window[BOOT_TIMER_KEY] = setInterval(() => {
            if ($('#coursetree').length > 0) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
            }
        }, 1000);
    }

    function initializePlayer() {
        const app = {
            configs: {
                // 倍速不归本脚本管，交给外部插件
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: true,
                // 同一小节内多个视频之间的切换间隔（数组 = 随机区间）
                nextVideoDelayMs: [800, 2200],
                // 全部处理完、切下一小节前的停顿（数组 = 随机区间）
                nextUnitDelayMs: [4000, 18000],
                multiVideoInOneSection: true,
                scanIframeDepth: 3,

                /* 标签页 */
                // 每个标签页里确认几次 video 元素，没找到就换下一个
                stepTabChecks: 2,
                stepTabCheckIntervalMs: 1000,
                // 点开标签页后等它渲染的时间
                stepTabLoadWaitMs: 1000,
                // 命中这些字样的标签页永不点击，脚本也不会在其中操作
                blockedStepPattern: /测试|测验|考试|作业|讨论|直播/,

                /* 跳过规则 */
                // 跳过任务点已完成的小节
                skipDoneSections: true,
                // true = 只打印日志、不真正跳过（演练）
                doneSkipDryRun: false,
                // 跳过任务点已完成的视频（.ans-attach-ct 带 ans-job-finished）
                skipDoneVideos: true,
                // 小节名命中这些词的整节跳过
                skipSectionNamePattern: /测试|测验|考试/,
            },
            _videoEl: null,
            // 当前页面上（含 iframe 内）收集到的所有视频，按出现顺序排列
            _videoList: [],
            _videoIndex: 0,
            _switchVideoPending: false,
            _treeContainerEl: null,
            _isPlaying: false,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: "",
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                console.log("%c=== 学习通自动刷课脚本 v4.4.1 启动（跳小节级 + 视频级已完成） ===", "color:#4CAF50;font-size:16px;font-weight:bold");
                this._nextUnitPending = false;
                this._tryTimes = 0;
                this._processedStepTabs = null;
                this._stepTabCheckCount = 0;
                this._resetVideoList();
                this._getTreeContainer();
                this._initCellData();
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();

                // 如果当前停在的小节已完成、或名字命中跳过规则，直接往后找
                if (!this.configs.doneSkipDryRun) {
                    try {
                        const el = this._getTreeContainer();
                        const cells = el.children("ul").children("li");
                        const nCells = $(cells.get(this._cellData.currentCellIndex || 0))
                            .find('.posCatalog_select:not(.firstLayer)');
                        const current = nCells.get(this._cellData.currentNCellIndex || 0);
                        const skipReason = current ? this._isSectionSkippable(current) : '';
                        if (skipReason) {
                            const what = skipReason === 'name' ? '小节名命中跳过规则' : '已完成';
                            console.log(`%c当前小节${what}，跳过: ${this._sectionTitle(current)}`, 'color:#9E9E9E');
                            this.nextUnit();
                            return;
                        }
                    } catch (e) {}
                }

                this.play();
            },
            // 任务点完成判定：有 icon_Completed 且没有 jobUnfinishCount 才算完成
            _isTaskDone(node) {
                if (!node) return false;
                const $n = $(node);
                // 只要还显示未完成计数，就一律当作没完成
                if ($n.find('.jobUnfinishCount').length > 0) return false;
                return $n.find('.icon_Completed').length > 0;
            },
            _sectionTitle(node) {
                const $name = $(node).find('.posCatalog_name').first();
                return (($name.attr('title') || $name.text()) || '').trim() || '(无标题)';
            },
            // 小节名是否命中跳过规则（测试/测验/考试…）
            _isNameSkipped(node) {
                const pattern = this.configs.skipSectionNamePattern;
                if (!pattern) return false;
                const title = this._sectionTitle(node).replace(/\s+/g, '');
                return pattern.test(title);
            },
            // 这一节是否应该整个跳过（已完成的 + 名字命中规则的）
            _isSectionSkippable(node) {
                if (this.configs.skipDoneSections && this._isTaskDone(node)) return 'done';
                if (this._isNameSkipped(node)) return 'name';
                return '';
            },
            // 未完成任务点数量，仅用于日志
            _unfinishCount(node) {
                const $c = $(node).find('.jobUnfinishCount').first();
                if (!$c.length) return 0;
                const m = ($c.text() || '').match(/\d+/);
                return m ? Number(m[0]) : 1;
            },
            // 从当前位置往后找下一个需要处理的小节；找到就进去，全部走完则返回 false
            _gotoNextPendingSection() {
                const el = this._getTreeContainer();
                const cells = el.children("ul").children("li");
                const totalCells = cells.length;

                let ci = this._cellData.currentCellIndex || 0;
                let ni = (this._cellData.currentNCellIndex || 0) + 1; // 从下一个开始

                while (ci < totalCells) {
                    const nCells = $(cells.get(ci)).find('.posCatalog_select:not(.firstLayer)');

                    while (ni < nCells.length) {
                        const node = nCells.get(ni);
                        const skipReason = this._isSectionSkippable(node);

                        if (skipReason) {
                            const what = skipReason === 'name' ? '小节名命中跳过规则' : '已完成';
                            if (this.configs.doneSkipDryRun) {
                                // 演练模式：只报告，仍然进入
                                console.log(`%c[演练] 这一段${what}，正式模式下会被跳过: ${this._sectionTitle(node)}`, 'color:#FFC107');
                            } else {
                                console.log(`%c跳过（${what}）: ${this._sectionTitle(node)}`, 'color:#9E9E9E');
                                ni++;
                                continue;
                            }
                        }

                        this._cellData.currentCellIndex = ci;
                        this._cellData.currentNCellIndex = ni;
                        const left = this._unfinishCount(node);
                        console.log(
                            `%c切换到 第${ci + 1}章 第${ni + 1}/${nCells.length}节：${this._sectionTitle(node)}` +
                            (left > 0 ? `（待完成 ${left} 个任务点）` : ''),
                            "color:#FF9800"
                        );
                        this.playCurrentIndex(node);
                        return true;
                    }

                    ci++;
                    ni = 0;
                    if (ci < totalCells) {
                        console.log(`%c本章无待处理小节，进入第 ${ci + 1} 章`, "color:#607D8B");
                    }
                }

                console.log("%c=====================================", "color:#4CAF50;font-size:16px");
                console.log("%c==============本课程学习完成了==============", "color:#4CAF50;font-size:16px;font-weight:bold");
                console.log("%c=====================================", "color:#4CAF50;font-size:16px");
                return false;
            },
            nextUnit() {
                if (this._nextUnitPending) {
                    console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();
                console.log("%c=== 准备切换到下一小节 ===", "color:#2196F3;font-size:14px");
                try {
                    this._gotoNextPendingSection();
                } catch (error) {
                    this._nextUnitPending = false;
                    console.error('切换下一小节失败:', error);
                }
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _tryResumePlayback(reason) {
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) {
                    return;
                }
                this._guardLastResumeTs = now;

                const video = this._getVideoEl();
                if (!video || !this._isPlaying) return;

                console.log(`%c触发视频保活恢复(${reason})`, "color:#607D8B");
                video.play().catch((e) => {
                    console.warn("直接恢复播放失败，尝试静音恢复:", e);
                    video.muted = true;
                    video.play().catch((err) => {
                        console.error("静音恢复播放失败:", err);
                    });
                });
            },
            _checkVideoStatus() {
                try {
                    const video = this._getVideoEl();
                    if (!video) return;

                    if (video.paused && this._isPlaying) {
                        console.log("%c检测到视频暂停，尝试恢复播放...", "color:#FF5722");
                        this._tryResumePlayback("paused");
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback("no-progress");
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                    if (video.ended && this._isPlaying) {
                        console.log("%c检测到视频结束，准备切换下一个...", "color:#9C27B0");
                        this._isPlaying = false;
                        this._handleVideoFinished('轮询检测到播放结束');
                    }
                } catch (e) {
                    console.error("视频状态检查失败:", e);
                }
            },
            _tryTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            // 本小节内「已经打开过」的标签页文字，保证每个只开一次
            _processedStepTabs: null,
            // 当前标签页里已检查过几次 video 元素
            _stepTabCheckCount: 0,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                try {
                    const el = this._getVideoEl();
                    if (el == null) {
                        // 本标签页没有 video：先确认几次，再换下一个标签页
                        const stepTitle = this._currentStepTitle();

                        // 危险步骤（测试/测验/考试…）：脚本绝不在这里操作
                        if (this._isBlockedStep(stepTitle)) {
                            this._isPlaying = false;
                            this._clearCheckInterval();
                            console.warn(
                                `%c当前步骤「${stepTitle}」在保护名单内（如课堂测试），脚本已停止自动操作，不会点击任何标签页。请手动完成。`,
                                'color:#F44336;font-weight:bold'
                            );
                            return;
                        }

                        // 第一段：本标签页里再确认几次，排除「只是渲染慢」
                        if (this._stepTabCheckCount < this.configs.stepTabChecks) {
                            this._stepTabCheckCount++;
                            const checkDelay = this.configs.stepTabCheckIntervalMs;
                            console.log(
                                `%c本标签页未找到 video 元素，${(checkDelay / 1000).toFixed(1)}秒后再确认一次 (${this._stepTabCheckCount}/${this.configs.stepTabChecks})`,
                                "color:#FF9800"
                            );
                            setTimeout(() => {
                                this._refreshVideoList(false);
                                this.play();
                            }, checkDelay);
                            return;
                        }

                        // 第二段：确认本标签页没有视频 → 按顺序打开下一个还没开过的标签页
                        if (this._advanceLearningStep()) {
                            const tabDelay = this.configs.stepTabLoadWaitMs;
                            console.log(`%c本标签页无视频，${(tabDelay / 1000).toFixed(1)}秒后打开下一个学习标签页`, "color:#00BCD4");
                            setTimeout(() => {
                                this._enterCurrentStepTab();
                            }, tabDelay);
                            return;
                        }

                        // 所有标签页都开过了 → 整个小节处理完毕，切下一小节
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        if (this.configs.autoAdvanceNoVideo) {
                            console.warn('%c本小节所有学习标签页均已处理，切换到下一小节', 'color:#FF9800');
                            this.nextUnit();
                        } else {
                            console.warn('%c本小节所有学习标签页均已处理，脚本已安全停止。确认无需完成课件后，可执行 app.nextUnit()。', 'color:#FF9800');
                        }
                        return;
                    }

                    this._stepTabCheckCount = 0;
                    this._markCurrentTabProcessed();
                    this._isPlaying = true;
                    this._videoEventHandle();

                    try {
                        await el.play();
                        this._tryTimes = 0;
                        console.log(`%c视频开始播放（本小节第 ${this._videoIndex + 1}/${Math.max(this._videoList.length, 1)} 个视频）`, "color:#4CAF50");
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error("视频播放失败:", playError);
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error("%c视频播放失败，已达到最大重试次数", "color:#F44336;font-weight:bold", e);
                        this._clearCheckInterval();
                        return;
                    }
                    this._tryTimes++;
                    console.log(`%c播放失败，${this.configs.retryInterval/1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, "color:#FF9800");
                    setTimeout(() => {
                        this.play();
                    }, this.configs.retryInterval);
                }
            },
            // 是否是需要手动处理的危险步骤（课堂测试/测验/作业/考试…）。
            _isBlockedStep(title) {
                const text = String(title || '').replace(/\s+/g, '');
                if (!text) return false;
                const pattern = this.configs.blockedStepPattern;
                if (!pattern) return false;
                return pattern.test(text);
            },
            // 按 DOM 顺序打开下一个还没打开过的标签页；没有更多时返回 false
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 400) {
                    return true;
                }
                if (!this._processedStepTabs) this._processedStepTabs = new Set();

                const tabs = [];
                $(".prev_white:visible").each((_, el) => {
                    const $el = $(el);
                    const text = ($el.text() || "").replace(/\s+/g, "");
                    if (!text) return;

                    // 危险步骤（课堂测试/测验/考试…）：永不点击
                    if (this._isBlockedStep(text)) return;

                    // 排除「上一节/下一节」这类导航按钮，否则会跳掉一整节
                    if (/下一节|上一节|下一章|上一章|下一讲|上一讲|返回|更多|收起|展开/.test(text)) return;

                    // 本小节内已经打开过的标签页不再重复打开（这也是防死循环的关键）
                    if (this._processedStepTabs.has(text)) return;

                    tabs.push({ el, text });
                });

                if (tabs.length === 0) {
                    return false; // 本小节所有标签页都处理过了
                }

                const target = tabs[0]; // DOM 顺序 = 从前到后依次打开
                this._processedStepTabs.add(target.text);
                this._stepTabCheckCount = 0;

                this._stepSwitchPending = true;
                this._stepSwitchAt = Date.now();
                console.log(`%c打开学习标签页「${target.text}」查找视频`, "color:#2196F3");
                // 打标记避免这次点击又触发脚本自己的 _bindStepNavigation
                this._selfClicking = true;
                try {
                    target.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                } finally {
                    this._selfClicking = false;
                }
                return true;
            },
            // 打开一个标签页之后：重新收集 video、跳过已播完的旧视频、继续播放
            _enterCurrentStepTab() {
                this._resetVideoList();
                this._refreshVideoList(false);
                // 旧标签页的 video 可能还在 DOM 里，游标要跳到未播完的那个
                const idx = (this._videoList || [])
                    .findIndex((v) => v && v.isConnected && !this._isVideoFinished(v));
                this._videoIndex = idx >= 0 ? idx : 0;
                this._videoEl = null;
                this._stepTabCheckCount = 0;
                try {
                    this._initCellData();
                } catch (e) {}
                this._isPlaying = false;
                if (this.configs.autoplay) {
                    this.play();
                }
            },
            // 把当前已激活的标签页也标记为已处理，避免播完后重复点它一次
            _markCurrentTabProcessed() {
                const title = this._currentStepTitle();
                if (!title || title.length < 2) return;
                if (!this._processedStepTabs) this._processedStepTabs = new Set();
                $(".prev_white:visible").each((_, el) => {
                    const text = ($(el).text() || "").replace(/\s+/g, "");
                    if (text && text.includes(title)) this._processedStepTabs.add(text);
                });
            },
            _currentStepTitle() {
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                return prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._resetVideoList();
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (e) {}
                        // 页签切换后播放器内的视频可能整个被替换，重新收集一次
                        this._resetVideoList();
                        this.play();
                    }, 1800);
                };

                $(document).off('click.xuexitongPlayerV3', '.prev_white').on('click.xuexitongPlayerV3', '.prev_white', (e) => {
                    if (this._selfClicking) {
                        // 脚本自己触发的页签点击，后续由 playCurrentIndex 的流程接管，不重复进入
                        return;
                    }
                    const text = ($(e.currentTarget).text() || "").replace(/\s+/g, "");
                    if (text.includes("视频")) {
                        console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, "color:#607D8B");
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                console.error("播放错误详情:", error);
                const video = this._getVideoEl();
                if (video) {
                    video.muted = true;
                    video.play().then(() => {
                        console.log("%c静音播放成功", "color:#4CAF50");
                        this._tryTimes = 0;
                        this._startVideoMonitoring();
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                            this._delayedNextUnitTimer = null;
                        }
                    }).catch(e => {
                        console.error("静音播放也失败:", e);
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                        }
                        this._isPlaying = false;
                        if (this._tryTimes >= this.configs.maxRetries) {
                            console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                            return;
                        }
                        this._tryTimes++;
                        this._delayedNextUnitTimer = setTimeout(() => {
                            this._delayedNextUnitTimer = null;
                            this.play();
                        }, this.configs.retryInterval);
                    });
                }
            },
            playCurrentIndex(nCell) {
                this._nextUnitPending = false;
                // 进入新小节：重置「已打开的标签页」名单，从头按顺序重新打开
                this._processedStepTabs = null;
                this._stepTabCheckCount = 0;
                if (!nCell) {
                    const el = this._getTreeContainer();
                    const cells = el.children("ul").children("li");
                    const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    nCell = nCells.get(this._cellData.currentNCellIndex);
                }

                const $nCell = $(nCell);
                const clickableSpan = $nCell.find(".posCatalog_name")[0];
                if (!clickableSpan) {
                    console.error("%c===========找不到可点击的课程节点，播放下一个视频失败==============", "color:#F44336");
                    return;
                }

                console.log(`%c点击切换到: ${$(clickableSpan).attr('title') || '未知标题'}`, "color:#2196F3");
                $(clickableSpan).click();
                this._resetVideoList();

                console.log("%c等待视频加载...", "color:#FF9800");
                setTimeout(() => {
                    this._resetVideoList();
                    this._initCellData();
                    if (this.configs.autoplay) {
                        this.play();
                    }
                }, 4000);
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children("ul").children("li");
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, v) => {
                    const nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((j, e) => {
                        const _el = $(e);
                        if (_el.hasClass("posCatalog_active")) {
                            this._cellData.currentCellIndex = i;
                            this._cellData.currentNCellIndex = j;
                            foundCurrent = true;
                            const titleSpan = _el.find('.posCatalog_name')[0];
                            if (titleSpan) {
                                this._cellData.currentVideoTitle = $(titleSpan).attr('title');
                            }
                        }
                    });
                });

                this._cellData.nCells = nCellCounts;

                if (!foundCurrent && nCellCounts > 0) {
                    console.warn("%c未找到当前激活的视频节点，可能需要手动选择", "color:#FF9800");
                }

                console.log(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, "color:#607D8B");
            },
            _getTreeContainer() {
                if (!this._treeContainerEl) {
                    const el = $('#coursetree');
                    if (el.length <= 0) {
                        throw new Error("找不到视频列表");
                    }
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },


            // 切换小节 / 切换页签时调用：丢弃旧列表，下次 _getVideoEl() 会重新收集
            _resetVideoList() {
                this._videoList = [];
                this._videoIndex = 0;
                this._videoEl = null;
                this._switchVideoPending = false;
            },
            _refreshVideoList(resetIndex) {
                this._videoList = this._collectVideoEls();
                if (resetIndex) {
                    this._videoIndex = 0;
                }
                if (this._videoIndex >= this._videoList.length) {
                    this._videoIndex = 0;
                }
                return this._videoList;
            },
            // 收集当前页面与各级 iframe 里的所有 <video>（必须全量，不能收紧成白名单）
            _collectVideoEls() {
                const collected = [];
                const seen = new Set();

                const walk = (doc, depth) => {
                    if (!doc || depth > this.configs.scanIframeDepth) return;

                    let nodes = [];
                    try {
                        nodes = doc.querySelectorAll('video');
                    } catch (e) {
                        return;
                    }
                    nodes.forEach((v) => {
                        if (seen.has(v)) return;
                        seen.add(v);
                        if (v && v.isConnected) collected.push(v);
                    });

                    let frames = [];
                    try {
                        frames = doc.querySelectorAll('iframe');
                    } catch (e) {
                        return;
                    }
                    frames.forEach((frame) => {
                        let frameDoc = null;
                        try {
                            frameDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
                        } catch (e) {
                            frameDoc = null; // 跨域 iframe，忽略
                        }
                        if (frameDoc) walk(frameDoc, depth + 1);
                    });
                };

                walk(document, 0);

                // 若存在可见的视频，只保留可见的，避免误抓隐藏的预加载元素
                const visible = collected.filter((v) => this._isVideoVisible(v));
                const base = visible.length > 0 ? visible : collected;

                // 剔除「所属任务点已完成」的视频
                if (!this.configs.skipDoneVideos) return base;
                const finished = this._collectFinishedVideos();
                if (finished.size === 0) return base;

                const kept = [];
                if (!this._loggedSkippedVideos) this._loggedSkippedVideos = new WeakSet();
                base.forEach((v) => {
                    if (finished.has(v)) {
                        // 同一个视频只打印一次，避免每次扫描都刷屏
                        const once = !this._loggedSkippedVideos.has(v);
                        if (once) this._loggedSkippedVideos.add(v);
                        if (this.configs.doneSkipDryRun) {
                            if (once) console.log('%c[演练] 该视频所属任务点已完成，正式模式下会跳过它', 'color:#FFC107');
                            kept.push(v);
                        } else if (once) {
                            console.log('%c跳过已完成任务点里的视频', 'color:#9E9E9E');
                        }
                        return;
                    }
                    kept.push(v);
                });
                return kept;
            },
            // 收集「所在任务点已完成」的 video（.ans-attach-ct 带 ans-job-finished；video 在更深层 iframe 里）
            _collectFinishedVideos() {
                const done = new Set();
                if (!this.configs.skipDoneVideos) return done;

                const collectIn = (doc, scopeEl, depth) => {
                    if (!doc || depth > 4) return;
                    try {
                        doc.querySelectorAll('video').forEach((v) => {
                            if (scopeEl && !scopeEl.contains(v)) return;
                            done.add(v);
                        });
                    } catch (e) {}
                    try {
                        doc.querySelectorAll('iframe').forEach((f) => {
                            if (scopeEl && !scopeEl.contains(f)) return;
                            let fd = null;
                            try { fd = f.contentDocument; } catch (e) { fd = null; }
                            if (fd) collectIn(fd, fd.body, depth + 1);
                        });
                    } catch (e) {}
                };

                const walk = (doc, depth) => {
                    if (!doc || depth > 3) return;
                    try {
                        doc.querySelectorAll('.ans-attach-ct').forEach((el) => {
                            let finished = false;
                            try { finished = el.classList && el.classList.contains('ans-job-finished'); } catch (e) {}
                            if (!finished) return;
                            collectIn(doc, el, 0);
                        });
                    } catch (e) {}
                    try {
                        doc.querySelectorAll('iframe').forEach((f) => {
                            let fd = null;
                            try { fd = f.contentDocument; } catch (e) { fd = null; }
                            if (fd) walk(fd, depth + 1);
                        });
                    } catch (e) {}
                };

                try { walk(document, 0); } catch (e) {}
                return done;
            },
            _isVideoVisible(v) {
                if (!v) return false;
                if (typeof v.getBoundingClientRect === 'function') {
                    const rect = v.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return true;
                }
                return v.offsetWidth > 0 && v.offsetHeight > 0;
            },
            _isVideoFinished(v) {
                if (!v) return true;
                if (v.ended) return true;
                const duration = Number(v.duration);
                if (Number.isFinite(duration) && duration > 0) {
                    return v.currentTime >= duration - 1;
                }
                return false;
            },
            // 找同一小节内下一个还没播完的视频，没有则返回 -1
            _findNextUnfinishedVideoIndex() {
                if (!this.configs.multiVideoInOneSection) {
                    // 关闭多视频支持时，视为「本节只有当前这一个视频」，播完直接切下一小节
                    return -1;
                }
                if (!Array.isArray(this._videoList) || this._videoList.length === 0) {
                    return -1;
                }

                const order = [];
                for (let i = this._videoIndex + 1; i < this._videoList.length; i++) order.push(i);
                for (let i = 0; i < this._videoIndex; i++) order.push(i);

                for (const i of order) {
                    const v = this._videoList[i];
                    if (!v || !v.isConnected) continue;
                    if (this._isVideoFinished(v)) continue;
                    return i;
                }
                return -1;
            },
            // 从毫秒区间 [min, max] 里随机取一个延迟；传单个数则原样返回
            _randomDelay(range, fallback) {
                if (typeof range === 'number' && range >= 0) {
                    return Math.round(range);
                }
                if (!Array.isArray(range) || range.length < 2) {
                    return Math.round(Number(fallback) || 0);
                }
                const min = Math.max(0, Number(range[0]) || 0);
                const max = Math.max(min, Number(range[1]) || min);
                return Math.round(min + Math.random() * (max - min));
            },
            // 视频播放结束的统一出口：本小节还有没播完的接着播，全播完才切下一节
            _handleVideoFinished(reason) {
                if (this._switchVideoPending) {
                    return;
                }

                if (!Array.isArray(this._videoList) || !this._videoList.some((v) => v.isConnected)) {
                    this._refreshVideoList(false);
                }

                const nextIndex = this._findNextUnfinishedVideoIndex();
                if (nextIndex !== -1) {
                    this._switchVideoPending = true;
                    this._isPlaying = false;
                    this._clearCheckInterval();
                    const videoDelay = this._randomDelay(this.configs.nextVideoDelayMs, 1200);
                    console.log(
                        `%c当前小节还有未播放的视频，继续播放第 ${nextIndex + 1}/${this._videoList.length} 个（${reason}），${(videoDelay / 1000).toFixed(1)}秒后继续`,
                        "color:#00BCD4"
                    );
                    setTimeout(() => {
                        this._switchVideoPending = false;
                        this._videoIndex = nextIndex;
                        this._videoEl = null;
                        if (this.configs.autoplay) {
                            this.play();
                        }
                    }, videoDelay);
                    return;
                }

                // 本标签页播完 → 打开下一个标签页；所有标签页都处理完才切下一小节
                if (this._advanceLearningStep()) {
                    const tabDelay = this.configs.stepTabLoadWaitMs;
                    console.log(
                        `%c本标签页已播完，${(tabDelay / 1000).toFixed(1)}秒后打开下一个学习标签页（${reason}）`,
                        "color:#00BCD4"
                    );
                    setTimeout(() => {
                        this._enterCurrentStepTab();
                    }, tabDelay);
                    return;
                }

                const unitDelay = this._randomDelay(this.configs.nextUnitDelayMs, 8000);
                console.log(`%c本小节所有学习标签页均已处理完，${(unitDelay / 1000).toFixed(1)}秒后切换下一小节`, "color:#4CAF50");
                setTimeout(() => this.nextUnit(), unitDelay);
            },
            _getVideoEl() {
                // 缓存元素仍在 DOM 中，直接复用
                if (this._videoEl && this._videoEl.isConnected) {
                    const cachedIndex = Array.isArray(this._videoList) ? this._videoList.indexOf(this._videoEl) : -1;
                    if (cachedIndex !== -1) {
                        this._videoIndex = cachedIndex;
                    }
                    return this._videoEl;
                }

                this._videoEl = null;

                const listAlive = Array.isArray(this._videoList)
                    && this._videoList.length > 0
                    && this._videoList.some((v) => v.isConnected);

                if (!listAlive) {
                    this._refreshVideoList(false);
                } else {
                    this._videoList = this._videoList.filter((v) => v.isConnected);
                    if (this._videoIndex >= this._videoList.length) {
                        this._videoIndex = 0;
                    }
                }

                this._videoEl = this._videoList[this._videoIndex] || null;
                return this._videoEl;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log("videoEl未加载");
                    return;
                }

                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };

                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded(e) {
                const el = this._getVideoEl();
                // 只处理当前正在播放的那个视频，避免同小节其它视频的 ended 事件干扰
                if (el && e && e.target && e.target !== el) {
                    return;
                }
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============'${title}' 播放完成=============`, "color:#4CAF50;font-weight:bold");
                this._isPlaying = false;
                this._clearCheckInterval();
                this._handleVideoFinished('播放结束事件');
            },
            _handleVideoLoaded(e) {
                console.log(`%c============视频加载完成=============`, "color:#2196F3");
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============'${title}' 开始播放=============`, "color:#4CAF50");
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number(video?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause(e) {
                console.log(`%c============视频暂停=============`, "color:#FF9800");
            },
            _bindPageGuards() {
                const preventPause = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                };
                const resumePlaybackNow = () => this._tryResumePlayback('page-event');
                this._pageGuards = { preventPause, resumePlaybackNow };
                document.addEventListener('mouseleave', preventPause);
                window.addEventListener('mouseleave', preventPause);
                document.addEventListener('mouseout', preventPause);
                window.addEventListener('mouseout', preventPause);
                window.addEventListener('blur', resumePlaybackNow);
                document.addEventListener('visibilitychange', resumePlaybackNow);
            },
            destroy() {
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                this._resetVideoList();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                $(document).off('.xuexitongPlayerV3');
                if (this._pageGuards) {
                    const { preventPause, resumePlaybackNow } = this._pageGuards;
                    document.removeEventListener('mouseleave', preventPause);
                    window.removeEventListener('mouseleave', preventPause);
                    document.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('blur', resumePlaybackNow);
                    document.removeEventListener('visibilitychange', resumePlaybackNow);
                    this._pageGuards = null;
                }
            },
        };

        window.app = app;
        window[APP_KEY] = app;

        try {
            app.run();
            app._bindPageGuards();
        } catch (error) {
            console.error("%c脚本运行失败: ", "color:#F44336;font-weight:bold", error.message);
            console.log("请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。");
        }
    }
})();

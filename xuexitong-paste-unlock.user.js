// ==UserScript==
// @name         学习通粘贴限制解除
// @namespace    local.codex.xuexitong
// @version      2.0.0
// @description  解除学习通作业答题区的粘贴限制（拦截 preventDefault、锁定 editorPaste、关闭 UEditor 粘贴过滤）
// @author       Codex
// @match        *://*.chaoxing.com/*dowork*
// @match        *://*.chaoxing.com/*work*
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '%c[粘贴解锁]';
    const STYLE = 'color:#4CAF50;font-weight:bold';
    const log = (...args) => console.log(TAG, STYLE, ...args);
    const warn = (...args) => console.warn(TAG, 'color:#FF9800;font-weight:bold', ...args);

    const stats = { preventDefaultBlocked: 0, editorsCleaned: 0, ticks: 0, uePatched: 0, toastBlocked: 0 };
    window.__pasteUnlock = {
        version: '2.0.0',
        stats,
        status() {
            console.table(stats);
            return stats;
        },
    };

    log('脚本已注入', location.href);

    /* ============ ① 核心：让 preventDefault() 对粘贴事件失效 ============
       学习通拦粘贴最常用的手段就是在 paste 监听器里调 e.preventDefault()。
       把它改成「粘贴事件不可被取消」，浏览器就会照常执行默认插入行为。 */
    try {
        const origPreventDefault = Event.prototype.preventDefault;
        Event.prototype.preventDefault = function () {
            if (this && (this.type === 'paste' || this.type === 'beforepaste' || this.type === 'drop')) {
                stats.preventDefaultBlocked++;
                return; // 放行，不取消默认粘贴
            }
            return origPreventDefault.apply(this, arguments);
        };
    } catch (e) {
        warn('preventDefault 改写失败', e);
    }

    /* ============ ② 锁定 editorPaste，防止被页面重新覆盖 ============ */
    const alwaysTrue = function () { return true; };
    try {
        Object.defineProperty(window, 'editorPaste', {
            configurable: true,
            get() { return alwaysTrue; },
            set() { /* 忽略页面后续的重新赋值 */ },
        });
    } catch (e) {
        window.editorPaste = alwaysTrue;
        warn('editorPaste 无法锁定，已退化为直接赋值', e);
    }

    /* ============ ③ 清掉编辑器上的粘贴相关限制 ============ */
    const BAD_ATTRS = ['onpaste', 'onbeforepaste', 'oncopy', 'oncut', 'ondrop', 'ondragover', 'oncontextmenu'];
    const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [contenteditable=""], .edui-body-container, .edui-editor-body';

    function cleanDoc(doc) {
        if (!doc) return;
        let list;
        try {
            list = doc.querySelectorAll(EDITOR_SELECTOR);
        } catch (e) {
            return;
        }
        list.forEach((el) => {
            stats.editorsCleaned++;
            for (const attr of BAD_ATTRS) {
                try {
                    if (el[attr]) el[attr] = null;
                    if (el.removeAttribute) el.removeAttribute(attr);
                } catch (e) {}
            }
            // 有些页面用 CSS 把输入区设成不可选
            try {
                if (el.style && el.style.userSelect === 'none') el.style.userSelect = '';
                if (el.style && el.style.webkitUserSelect === 'none') el.style.webkitUserSelect = '';
                if (el.style && el.style.webkitUserModify) el.style.webkitUserModify = '';
                if (el.getAttribute && el.getAttribute('unselectable')) el.removeAttribute('unselectable');
                if (el.contentEditable === 'false' && el.classList &&
                    (el.classList.contains('edui-body-container') || el.classList.contains('edui-editor-body'))) {
                    el.contentEditable = 'true';
                }
            } catch (e) {}
        });
    }

    function cleanAllFrames() {
        cleanDoc(document);
        let frames = [];
        try {
            frames = document.querySelectorAll('iframe, frame');
        } catch (e) {}
        frames.forEach((f) => {
            try {
                const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
                if (d) cleanDoc(d);
            } catch (e) {
                // 跨域 iframe 读不到，忽略；这种情况脚本必须匹配到那个 frame 自己的网址
            }
        });
    }

    /* ============ ④ 关闭 UEditor 的粘贴过滤 ============ */
    function patchUE() {
        try {
            if (!window.UE || !UE.instants) return;
            Object.keys(UE.instants).forEach((k) => {
                const ed = UE.instants[k];
                if (!ed || !ed.options) return;
                stats.uePatched++;
                try { ed.options.pasteFilter = false; } catch (e) {}
                try { ed.options.retainOnlyLabelPasted = false; } catch (e) {}
                try { ed.options.enableContextMenu = true; } catch (e) {}
                try { ed.removeListener('beforepaste'); } catch (e) {}
                try {
                    ed.addListener('beforepaste', function (type, data) {
                        if (data) data.html = data.html || '';
                        return true;
                    });
                } catch (e) {}
            });
        } catch (e) {}
    }

    /* ============ ⑤ 拦掉「只能录入不能粘贴」提示 ============
       注意：document-start 时 jQuery 还不存在，所以这里用轮询反复尝试，
       而不是像原脚本那样只在注入瞬间判断一次。 */
    function patchToast() {
        try {
            if (!window.$ || typeof $.toast !== 'function' || $.toast.__pasteUnlockPatched) return;
            const orig = $.toast;
            const wrapped = function (opt) {
                let txt = '';
                try {
                    txt = typeof opt === 'string' ? opt : (opt && (opt.content || opt.text)) || '';
                } catch (e) {}
                if (String(txt).indexOf('只能录入不能粘贴') !== -1 || String(txt).indexOf('不能粘贴') !== -1) {
                    stats.toastBlocked++;
                    log('已拦截提示：', txt);
                    return;
                }
                return orig.apply(this, arguments);
            };
            wrapped.__pasteUnlockPatched = true;
            $.toast = wrapped;
        } catch (e) {}
    }

    /* ============ 主循环 ============ */
    function tick() {
        stats.ticks++;
        cleanAllFrames();
        patchUE();
        patchToast();
    }

    // document-start 就能做的：全局覆盖已经生效（①②）
    // 其余需要 DOM / jQuery 就绪，用轮询 + MutationObserver 反复保证
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tick, { once: true });
    } else {
        tick();
    }
    setInterval(tick, 1000);

    try {
        const startObserver = () => {
            if (!document.body) return setTimeout(startObserver, 300);
            new MutationObserver(() => { cleanAllFrames(); }).observe(document.body, {
                childList: true,
                subtree: true,
            });
        };
        startObserver();
    } catch (e) {}

    /* ============ 右下角提示，用来确认脚本真的跑起来了 ============ */
    function showBadge() {
        if (!document.body) return setTimeout(showBadge, 300);
        if (document.getElementById('__pasteUnlockBadge')) return;
        const el = document.createElement('div');
        el.id = '__pasteUnlockBadge';
        el.textContent = '✅ 粘贴限制已解除（v2.0.0）';
        el.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
            'background:#4CAF50', 'color:#fff', 'padding:8px 12px', 'border-radius:6px',
            'font:13px/1.4 sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'opacity:.96',
            'pointer-events:none',
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .6s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 700);
        }, 5000);
        log('已显示运行标记。若没看到这个绿色提示，说明 @match 没匹配到本页面。');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showBadge, { once: true });
    } else {
        showBadge();
    }
})();

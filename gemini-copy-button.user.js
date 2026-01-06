// ==UserScript==
// @name         Gemini 复制按钮
// @namespace    https://github.com/zetaloop/gemini-copy-button
// @homepage     https://github.com/zetaloop/gemini-copy-button
// @author       zetaloop
// @version      1.0.0
// @description  在 Gemini 顶栏加入“复制全对话”图标按钮：按 user/assistant 顺序拼接，复用 Gemini 内置复制结果；不做 HTML->Markdown 转换。
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @downloadURL  https://github.com/zetaloop/gemini-copy-button/raw/refs/heads/main/gemini-copy-button.user.js
// @updateURL    https://github.com/zetaloop/gemini-copy-button/raw/refs/heads/main/gemini-copy-button.user.js
// ==/UserScript==

(function () {
    "use strict";

    const W =
        typeof unsafeWindow !== "undefined" && unsafeWindow
            ? unsafeWindow
            : window;

    const ID_TOAST = "__gemini_copy_all_toast";
    const ID_TOP = "__gemini_copy_all_btn_top";

    // ===== 输出格式配置 =====
    const USER_TAG = "「用户」\n";
    const ASSISTANT_TAG = "「助手」\n";
    const SEP = "\n\n========\n\n";

    const css = `
    top-bar-actions .top-bar-actions{
      position:relative;
    }

    /* 顶栏按钮：做成圆按钮，避免空白与挤压布局（仅作用于本按钮） */
    #${ID_TOP}{
      width: 40px !important;
      height: 40px !important;
      min-width: 40px !important;
      padding: 0 !important;
      border-radius: 9999px !important;
      position:absolute;
    }
    #${ID_TOP} .mdc-button__label{
      display:inline-flex !important;
      align-items:center;
      justify-content:center;
      width:100%;
      height:100%;
      padding:0 !important;
      margin:0 !important;
    }

    /* Toast：默认不占位，显示时定位在按钮下方 */
    #${ID_TOAST}{
      position:fixed;
      z-index:2147483647;
      padding:10px 12px;
      border-radius:12px;
      background:rgba(20,20,20,.92);
      color:#fff;
      font:13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,"Noto Sans","PingFang SC","Microsoft YaHei",sans-serif;
      box-shadow:0 10px 30px rgba(0,0,0,.25);
      opacity:0;
      transform:translateY(6px);
      transition:opacity .18s ease, transform .18s ease;
      pointer-events:none;
      max-width: min(520px, calc(100vw - 24px));
      word-break: break-word;
    }
    #${ID_TOAST}.__show{
      opacity:1;
      transform:translateY(0);
    }
  `;

    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
        const st = document.createElement("style");
        st.textContent = css;
        document.head.appendChild(st);
    }

    function toast(msg, anchorEl, ms = 1400) {
        let el = document.getElementById(ID_TOAST);
        if (!el) {
            el = document.createElement("div");
            el.id = ID_TOAST;
            document.body.appendChild(el);
        }
        el.textContent = msg;

        // 定位到按钮下方
        let left = 16;
        let top = 16;

        try {
            if (anchorEl?.getBoundingClientRect) {
                const r = anchorEl.getBoundingClientRect();
                top = Math.round(r.bottom + 8);
                left = Math.round(r.left);
                // 让 toast 不出屏幕：优先靠左对齐，必要时右移/左移
                requestAnimationFrame(() => {
                    const tr = el.getBoundingClientRect();
                    const pad = 8;
                    let newLeft = left - 36;
                    if (newLeft + tr.width > window.innerWidth - pad)
                        newLeft = Math.max(
                            pad,
                            window.innerWidth - pad - tr.width,
                        );
                    if (newLeft < pad) newLeft = pad;

                    let newTop = top;
                    if (newTop + tr.height > window.innerHeight - pad) {
                        // 下方放不下，就放到按钮上方
                        newTop = Math.max(
                            pad,
                            Math.round(r.top - 8 - tr.height),
                        );
                    }
                    el.style.left = `${newLeft}px`;
                    el.style.top = `${newTop}px`;
                });
            } else {
                el.style.left = `${left}px`;
                el.style.top = `${top}px`;
            }
        } catch {
            el.style.left = `16px`;
            el.style.top = `16px`;
        }

        el.classList.add("__show");
        setTimeout(() => el.classList.remove("__show"), ms);
    }

    async function setClipboard(text) {
        if (typeof GM_setClipboard === "function") {
            GM_setClipboard(text, "text");
            return;
        }
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }

    const CAP = { active: false, resolve: null, reject: null, timer: null };

    function finishCapture(payload) {
        if (!CAP.active) return;
        const r = CAP.resolve;
        clearTimeout(CAP.timer);
        CAP.active = false;
        CAP.resolve = null;
        CAP.reject = null;
        CAP.timer = null;
        r?.(payload);
    }

    function startCapture(timeoutMs = 1800) {
        CAP.active = true;
        return new Promise((resolve, reject) => {
            CAP.resolve = resolve;
            CAP.reject = reject;
            CAP.timer = setTimeout(() => {
                if (!CAP.active) return;
                CAP.active = false;
                CAP.resolve = null;
                CAP.reject = null;
                CAP.timer = null;
                reject(new Error("timeout"));
            }, timeoutMs);
        });
    }

    function pickTextFromClipboardEvent(e) {
        const dt = e.clipboardData;
        if (!dt || !dt.getData) return { text: "", mime: "" };
        const md = dt.getData("text/markdown");
        if (md) return { text: md, mime: "text/markdown" };
        const plain = dt.getData("text/plain");
        if (plain) return { text: plain, mime: "text/plain" };
        return { text: "", mime: "" };
    }

    async function pickTextFromClipboardItems(items) {
        const prefer = ["text/markdown", "text/plain"];
        for (const item of items || []) {
            const types = item?.types ? item.types : [];
            for (const t of prefer) {
                if (types.includes(t)) {
                    const blob = await item.getType(t);
                    const text = await blob.text();
                    return { text, mime: t };
                }
            }
        }
        return { text: "", mime: "" };
    }

    function installHooks() {
        if (W.__geminiCopyAllHooksInstalled) return true;
        W.__geminiCopyAllHooksInstalled = true;

        const clip = W.navigator?.clipboard ? W.navigator.clipboard : null;
        if (!clip) return true;

        const origWriteText = clip.writeText ? clip.writeText.bind(clip) : null;
        const origWrite = clip.write ? clip.write.bind(clip) : null;

        if (origWriteText) {
            try {
                clip.writeText = function (text) {
                    if (CAP.active) {
                        finishCapture({
                            text: String(text ?? ""),
                            mime: "text/plain",
                            via: "writeText",
                        });
                        return Promise.resolve();
                    }
                    return origWriteText(text);
                };
            } catch {}
        }

        if (origWrite) {
            try {
                clip.write = async function (items) {
                    if (CAP.active) {
                        const got = await pickTextFromClipboardItems(items);
                        finishCapture({
                            text: got.text,
                            mime: got.mime,
                            via: "write",
                        });
                        return Promise.resolve();
                    }
                    return origWrite(items);
                };
            } catch {}
        }

        document.addEventListener(
            "copy",
            function (e) {
                if (!CAP.active) return;
                const got = pickTextFromClipboardEvent(e);
                finishCapture({
                    text: got.text,
                    mime: got.mime,
                    via: "copyEvent",
                });
                e.preventDefault();
            },
            true,
        );

        return true;
    }

    function findCopyButtonForUser(userQueryEl) {
        return userQueryEl.querySelector(
            'button[aria-label="复制提示"],button[mattooltip="复制提示"],button[aria-label="Copy prompt"],button[mattooltip="Copy prompt"]',
        );
    }

    function findCopyButtonForAssistant(modelResponseEl) {
        const all = Array.from(
            modelResponseEl.querySelectorAll(
                'button[data-test-id="copy-button"]',
            ),
        );
        if (!all.length) return null;
        for (const b of all) {
            if (b.offsetParent !== null) return b;
        }
        return all[0];
    }

    function formatBlock(tag, content) {
        // tag 已自带 \n；content 保留原样；不强行追加尾部换行
        return `${tag}${String(content ?? "")}`;
    }

    async function captureFromClick(clickFn, timeoutMs = 1800) {
        const p = startCapture(timeoutMs);
        clickFn();
        return await p;
    }

    async function copyAllConversation(anchorBtn) {
        installHooks();

        const items = Array.from(
            document.querySelectorAll("user-query, model-response"),
        );
        if (!items.length) {
            toast("没找到对话内容", anchorBtn);
            return;
        }

        const btnTop = document.getElementById(ID_TOP);
        if (btnTop) btnTop.disabled = true;

        const blocks = [];
        for (let i = 0; i < items.length; i++) {
            const el = items[i];
            const tag = (el.tagName || "").toUpperCase();

            if (tag === "USER-QUERY") {
                const b = findCopyButtonForUser(el);
                if (!b) {
                    blocks.push(formatBlock(USER_TAG, ""));
                    continue;
                }
                try {
                    const cap = await captureFromClick(() => b.click());
                    blocks.push(formatBlock(USER_TAG, cap.text));
                } catch {
                    blocks.push(formatBlock(USER_TAG, ""));
                }
            }

            if (tag === "MODEL-RESPONSE") {
                const b = findCopyButtonForAssistant(el);
                if (!b) {
                    blocks.push(formatBlock(ASSISTANT_TAG, ""));
                    continue;
                }
                try {
                    const cap = await captureFromClick(() => b.click());
                    blocks.push(formatBlock(ASSISTANT_TAG, cap.text));
                } catch {
                    blocks.push(formatBlock(ASSISTANT_TAG, ""));
                }
            }
        }

        const finalText = blocks.join(SEP);

        try {
            await setClipboard(finalText);
            toast("已复制到剪贴板", anchorBtn);
        } catch (e) {
            toast(`复制失败：${e?.message ? e.message : e}`, anchorBtn);
        }

        if (btnTop) btnTop.disabled = false;
    }

    function findTopBarRoot() {
        const all = document.querySelectorAll(
            "top-bar-actions .top-bar-actions",
        );
        if (all.length !== 1) return null;
        return all[0];
    }

    function findCenterSection() {
        const all = document.querySelectorAll(
            "top-bar-actions .top-bar-actions .center-section",
        );
        if (all.length !== 1) return null;
        return all[0];
    }

    function findRightSection() {
        const all = document.querySelectorAll(
            "top-bar-actions .top-bar-actions .right-section",
        );
        if (all.length !== 1) return null;
        return all[0];
    }

    function sanitizeClonedButton(btn) {
        const killAttrs = [
            "aria-haspopup",
            "aria-controls",
            "aria-expanded",
            "aria-owns",
            "mat-menu-trigger-for",
            "data-mat-menu-trigger",
            "cdk-overlay-origin",
            "cdkconnectedoverlayorigin",
            "aria-describedby",
            "cdk-describedby-host",
            "jslog",
        ];
        for (const a of killAttrs) {
            try {
                btn.removeAttribute(a);
            } catch {}
        }
        btn.disabled = false;
        try {
            btn.removeAttribute("disabled");
        } catch {}
        try {
            btn.classList.remove("mat-mdc-button-disabled");
        } catch {}
    }

    function stripTextNodesExceptMatIcon(root) {
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            null,
        );
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const parent = n.parentElement;
            if (!parent) continue;
            if (parent.closest?.("mat-icon")) continue; // mat-icon 用 textContent 表示图标名
            if (n.nodeValue?.trim().length) n.nodeValue = "";
        }
    }

    function positionTopBarButton(btn) {
        const root = findTopBarRoot();
        const center = findCenterSection();
        if (!root || !center) return;

        const rr = root.getBoundingClientRect();
        const cr = center.getBoundingClientRect();

        const gap = 8;
        const left = Math.round(cr.right - rr.left + gap);
        const top = Math.round(cr.top - rr.top + (cr.height - 40) / 2);

        btn.style.left = `${left}px`;
        btn.style.top = `${top}px`;
    }

    function ensureTopBarButton() {
        const exist = document.getElementById(ID_TOP);
        if (exist) {
            requestAnimationFrame(() => positionTopBarButton(exist));
            return;
        }

        const root = findTopBarRoot();
        if (!root) return;

        const right = findRightSection();
        if (!right) return;

        const tpl = right.querySelector("button");
        if (!tpl) return;

        const btn = tpl.cloneNode(true);
        btn.id = ID_TOP;

        const label = "复制全对话";
        btn.setAttribute("aria-label", label);
        if (btn.hasAttribute("mattooltip"))
            btn.setAttribute("mattooltip", label);
        btn.title = label;

        sanitizeClonedButton(btn);

        try {
            btn.querySelectorAll("img,svg").forEach((n) => {
                n.remove();
            });
        } catch {}

        try {
            const labelEl = btn.querySelector(".mdc-button__label");
            if (labelEl) labelEl.textContent = "";

            let mi = btn.querySelector("mat-icon");
            if (!mi) mi = document.createElement("mat-icon");
            mi.className =
                "mat-icon notranslate gds-icon-l google-symbols mat-ligature-font mat-icon-no-color";
            mi.setAttribute("role", "img");
            mi.setAttribute("aria-hidden", "true");
            mi.removeAttribute("fonticon");
            mi.removeAttribute("data-mat-icon-name");
            mi.removeAttribute("data-mat-icon-type");
            mi.textContent = "content_copy";

            (labelEl || btn).insertBefore(mi, (labelEl || btn).firstChild);
        } catch {}

        stripTextNodesExceptMatIcon(btn);

        btn.addEventListener("click", (e) => {
            try {
                e.preventDefault();
                e.stopPropagation();
            } catch {}
            copyAllConversation(btn);
        });

        root.appendChild(btn);
        requestAnimationFrame(() => positionTopBarButton(btn));
    }

    ensureTopBarButton();

    const mo = new MutationObserver(() => {
        ensureTopBarButton();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("resize", () => {
        ensureTopBarButton();
    });
})();

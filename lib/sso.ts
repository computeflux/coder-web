/**
 * SSO 多服务登录（ComputeFlux 统一设计，pi-web 本地副本 — 不依赖 @wetee/web3auth）：
 * 登录只在枢纽（core-ui :5181）/ops/login 页弹登录框，其他服务
 * 一律跳转过去获取登录凭证。
 *
 *   1) 未登录（任意服务，含枢纽自身）/ 401 → 跳枢纽 /ops/login（?sso_next=原地址）
 *   2) /ops/login 页弹登录框；登录成功后：
 *        带 ?sso_next= → 读本地会话（key）→ 带 ?sso=base64(会话) 跳回原地址
 *        无 ?sso_next= → 回枢纽首页
 *   3) 原服务启动时从 URL 取 key 写入本地 localStorage
 *   4) **iframe 静默续期**（2026-10-28）：本地无会话 / 已过期时，先内嵌枢纽 /ops/sso
 *      隐藏 iframe，由枢纽用唯一 refresh token 续期后 postMessage 回传 → 无需跳转
 *      （轮换只在枢纽 origin 发生，跨 origin 各持拷贝会被重放检测吊销）；
 *      iframe 不可用/超时 → 回退到 1) 的跳转流程。
 *
 * 注意：key（含 refresh token）会短暂出现在 URL 中（replaceState 立即移除，不进 history）；
 * nginx access log 会记录该请求行。内部系统可接受；若上公网需改回 code 兑换方案。
 *
 * 所有函数 SSR 安全（服务端 no-op / 安全默认值）。
 */

const HUB_PORT = "5181"; // core-ui 单容器 = 登录枢纽（/ops 入口）

function hasWindow(): boolean {
    return typeof window !== "undefined";
}

export function hubUrl(): string {
    if (!hasWindow()) return "";
    return `${window.location.protocol}//${window.location.hostname}:${HUB_PORT}`;
}

export function isHubOrigin(): boolean {
    return hasWindow() && window.location.port === HUB_PORT;
}

/** 唯一的登录页（枢纽 core-ui :5181 /ops/login）：所有服务都来这里获取登录凭证 */
export function loginPath(next?: string): string {
    return next ? `/ops/login?sso_next=${encodeURIComponent(next)}` : "/ops/login";
}

export function loginUrl(next?: string): string {
    return `${hubUrl()}${loginPath(next)}`;
}

export function isHubLoginPage(): boolean {
    return isHubOrigin() && window.location.pathname === "/ops/login";
}

/** 统一"去获取登录凭证"入口：未登录 / 401 时，任何服务（含枢纽自身）都跳这里 */
export function redirectToLogin(): void {
    if (!hasWindow() || isHubLoginPage()) return;
    // 自动化浏览器（navigator.webdriver，如构建期 puppeteer 预渲染）：
    // 不跳转，避免页面导航销毁渲染上下文导致构建失败
    if (navigator.webdriver) return;
    const next = window.location.origin + window.location.pathname + window.location.search;
    window.location.replace(isHubOrigin() ? loginPath(next) : loginUrl(next));
}

// web3auth 持久化会话格式（localStorage "web3auth:session"，由枢纽登录流程写入）
export interface SsoSession {
    token: string;
    address: string;
    refreshToken?: string;
    userInfo?: unknown;
}

export function readStoredSession(): SsoSession | null {
    if (!hasWindow()) return null;
    try {
        const raw = localStorage.getItem("web3auth:session");
        if (!raw) return null;
        const s = JSON.parse(raw) as SsoSession;
        if (!s?.token || !s?.address) return null;
        return s;
    } catch {
        return null;
    }
}

function writeSession(s: SsoSession): void {
    localStorage.setItem("web3auth:session", JSON.stringify(s));
}

/** 清本地会话（web3auth:session + web3auth:user） */
export function clearStoredSession(): void {
    if (!hasWindow()) return;
    localStorage.removeItem("web3auth:session");
    localStorage.removeItem("web3auth:user");
}

// ---------------------------------------------------------------------------
// iframe 静默续期（跨 origin：本服务读不到枢纽 localStorage）
//
// 页面内嵌隐藏 iframe 指向枢纽 /ops/sso；枢纽 origin 用自己唯一的 refresh token
// 续期后 postMessage 回传会话。超时/失败 → null（调用方回退到跳转登录）。
// ---------------------------------------------------------------------------
const SSO_FRAME_PATH = "/ops/sso";
const SSO_SYNC_TIMEOUT_MS = 4000;
const SSO_SYNC_REQUEST = "sso:sync";
const SSO_SYNC_RESPONSE = "sso:session";

let syncInflight: Promise<SsoSession | null> | null = null;

/** 会话 token 是否仍有效（含 30s 缓冲；解析失败按有效处理，交给服务端 401） */
export function isSessionFresh(s: SsoSession | null): boolean {
    if (!s?.token) return false;
    try {
        let payload = s.token.split(".")[1];
        if (!payload) return true;
        payload = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
        const json = JSON.parse(decodeURIComponent(escape(atob(payload)))) as { exp?: number };
        return typeof json.exp === "number" ? json.exp * 1000 > Date.now() + 30_000 : true;
    } catch {
        return true;
    }
}

/**
 * 向枢纽 iframe 要一次会话（必要时由枢纽静默续期）。
 * 并发调用复用同一个 in-flight 请求；枢纽 origin 直接读本地会话。
 */
export function syncSessionViaIframe(timeoutMs = SSO_SYNC_TIMEOUT_MS): Promise<SsoSession | null> {
    if (!hasWindow()) return Promise.resolve(null);
    if (isHubOrigin()) return Promise.resolve(readStoredSession());
    syncInflight = syncInflight ?? doSyncSession(timeoutMs).finally(() => {
        syncInflight = null;
    });
    return syncInflight;
}

function doSyncSession(timeoutMs: number): Promise<SsoSession | null> {
    return new Promise((resolve) => {
        const origin = hubUrl();
        if (!origin) {
            resolve(null);
            return;
        }
        const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const frame = document.createElement("iframe");
        frame.src = `${origin}${SSO_FRAME_PATH}`;
        frame.title = "sso-sync";
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";

        let settled = false;
        let timer = 0;
        let retryTimers: number[] = [];

        const cleanup = () => {
            if (settled) return;
            settled = true;
            window.removeEventListener("message", onMessage);
            retryTimers.forEach((t) => window.clearTimeout(t));
            window.clearTimeout(timer);
            frame.remove();
        };

        const onMessage = (ev: MessageEvent) => {
            if (ev.origin !== origin) return;
            const data = ev.data as { type?: string; nonce?: string; session?: SsoSession | null } | null;
            if (!data || data.type !== SSO_SYNC_RESPONSE || data.nonce !== nonce) return;
            const s = data.session;
            if (s?.token && s.address) {
                writeSession(s);
                window.dispatchEvent(new Event("sso:session-synced"));
                cleanup();
                resolve(s);
                return;
            }
            cleanup();
            resolve(null);
        };

        timer = window.setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
        window.addEventListener("message", onMessage);

        // 握手重试：iframe onload 可能早于枢纽页挂载 message 监听（幂等 nonce，重复无副作用）
        const post = () => {
            if (settled) return;
            try {
                frame.contentWindow?.postMessage({ type: SSO_SYNC_REQUEST, nonce }, origin);
            } catch {
                /* 跨域异常 → 等超时回退 */
            }
        };
        frame.addEventListener("load", () => {
            post();
            retryTimers = [400, 1000].map((ms) => window.setTimeout(post, ms));
        });
        document.body.appendChild(frame);
    });
}

// 跨加载循环计数器（localStorage 存活跨页面）：
// 每次"跳登录页" +1；60 秒内 >3 次 → 停止跳转（防纯重定向死循环）
const SSO_LOOP_KEY = "web3auth:sso_loop";
const SSO_LOOP_WINDOW_MS = 60_000;
const SSO_LOOP_MAX = 3;

/** 返回 true = 已超限，调用方应停止跳转 */
export function bumpSsoLoop(): boolean {
    if (!hasWindow()) return false;
    try {
        const now = Date.now();
        const raw = localStorage.getItem(SSO_LOOP_KEY);
        let count = 1;
        let ts = now;
        if (raw) {
            const p = JSON.parse(raw) as { count?: number; ts?: number };
            if (p?.ts && now - p.ts < SSO_LOOP_WINDOW_MS) {
                count = (p.count ?? 0) + 1;
                ts = p.ts;
            }
        }
        if (count > SSO_LOOP_MAX) return true;
        localStorage.setItem(SSO_LOOP_KEY, JSON.stringify({ count, ts }));
        return false;
    } catch {
        return false; // 计数失败不拦截
    }
}

export function clearSsoLoop(): void {
    if (!hasWindow()) return;
    try {
        localStorage.removeItem(SSO_LOOP_KEY);
    } catch {
        /* ignore */
    }
}

// base64 的 URL-safe 变体：query string 里 `+` 会被 URLSearchParams 解码成空格，
// 标准 base64 拼进 ?sso= 必然损坏 → 用 -/_ 替代 +/（解码时还原）
function b64Decode(s: string): string {
    return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}

// 读取 URL 参数并立即移除（replaceState，不留 history 记录）
export function takeUrlParam(name: string): string | null {
    if (!hasWindow()) return null;
    const url = new URL(window.location.href);
    const v = url.searchParams.get(name);
    if (v === null) return null;
    url.searchParams.delete(name);
    window.history.replaceState({}, "", url.toString());
    return v;
}

/**
 * 各服务入口（main.tsx / 客户端模块作用域）在渲染前调用：
 * URL 带 ?sso=<base64 会话>（枢纽登录后的回跳）时，解码写入本地 localStorage。
 */
export function consumeSsoOnBoot(): void {
    if (!hasWindow()) return;
    const raw = takeUrlParam("sso");
    if (!raw) return;
    try {
        const s = JSON.parse(b64Decode(raw)) as SsoSession;
        if (s?.token && s.address) writeSession(s);
    } catch {
        /* 解码失败 → 回退正常登录流程 */
    }
}

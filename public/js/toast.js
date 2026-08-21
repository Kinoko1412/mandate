/**
 * Toast 通知——右下角堆疊，最多同時 3 則。一般通知自動淡出；
 * 危險／失敗通知（可能代表資料沒存到）需要使用者手動關閉，不自動消失
 * （呼應「資料安全優先」原則：合規人員不該因為沒注意到就被自動清掉一則失敗通知）。
 */

import { icon } from "./icons.js";

const ICON_BY_TYPE = { success: "check", neutral: "link", danger: "alert" };
const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 3200;

let stack = null;

function ensureStack() {
  if (stack && document.body.contains(stack)) return stack;
  stack = document.createElement("div");
  stack.className = "toast-stack";
  stack.setAttribute("aria-live", "polite");
  document.body.appendChild(stack);
  return stack;
}

/**
 * @param {string} message
 * @param {{ type?: "success"|"neutral"|"danger" }} [options]
 */
export function showToast(message, options = {}) {
  const type = options.type || "neutral";
  const root = ensureStack();
  while (root.children.length >= MAX_TOASTS) {
    root.removeChild(root.firstChild);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(ICON_BY_TYPE[type] || "link", "micon-sm")}<span></span>`;
  el.querySelector("span").textContent = message;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "關閉通知");
  closeBtn.innerHTML = icon("x", "micon-sm");
  closeBtn.addEventListener("click", () => dismiss(el));
  el.appendChild(closeBtn);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));

  if (type !== "danger") {
    setTimeout(() => dismiss(el), AUTO_DISMISS_MS);
  }
  return el;
}

function dismiss(el) {
  if (!el.parentNode) return;
  el.classList.remove("show");
  setTimeout(() => el.remove(), 200);
}

const authPanel = document.querySelector("#authPanel");
const appPanel = document.querySelector("#appPanel");
const authForm = document.querySelector("#authForm");
const uploadForm = document.querySelector("#uploadForm");
const authSubmit = document.querySelector("#authSubmit");
const logoutButton = document.querySelector("#logoutButton");
const statusLine = document.querySelector("#statusLine");
const sessionChip = document.querySelector("#sessionChip");
const fileList = document.querySelector("#fileList");
const fileInput = uploadForm.elements.attachment;
const fileLabel = document.querySelector("#fileLabel");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const dateLine = document.querySelector("#dateLine");

let authMode = "login";

dateLine.textContent = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short"
}).format(new Date());

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    authMode = button.dataset.mode;
    modeButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    authSubmit.textContent = authMode === "login" ? "登录" : "注册";
    authForm.elements.password.autocomplete = authMode === "login" ? "current-password" : "new-password";
    setStatus("");
  });
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(authForm);
  const payload = {
    username: formData.get("username"),
    password: formData.get("password")
  };

  const result = await requestJson(`/api/${authMode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    setStatus(result.error);
    return;
  }

  authForm.reset();
  setUser(result.data.user);
  await loadFiles();
});

logoutButton.addEventListener("click", async () => {
  await requestJson("/api/logout", { method: "POST" });
  setUser(null);
  fileList.innerHTML = "";
});

fileInput.addEventListener("change", () => {
  fileLabel.textContent = fileInput.files[0]?.name || "选择附件";
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: formData
  });

  if (!result.ok) {
    setStatus(result.error);
    return;
  }

  uploadForm.reset();
  fileLabel.textContent = "选择附件";
  setStatus("已上传");
  await loadFiles();
});

const me = await requestJson("/api/me");
setUser(me.ok ? me.data.user : null);
if (me.ok && me.data.user) {
  await loadFiles();
}

async function loadFiles() {
  const result = await requestJson("/api/files");
  if (!result.ok) {
    setStatus(result.error);
    return;
  }

  renderFiles(result.data.files);
}

function renderFiles(files) {
  if (!files.length) {
    fileList.innerHTML = '<div class="empty-state">还没有附件</div>';
    return;
  }

  fileList.innerHTML = files
    .map((file) => {
      const uploadedAt = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(file.uploadedAt));

      return `
        <div class="file-row">
          <div class="file-name">${escapeHtml(file.originalName)}</div>
          <div class="file-meta">${formatBytes(file.size)}</div>
          <a href="/api/files/${file.id}/download">下载</a>
          <div class="file-meta">${uploadedAt}</div>
        </div>
      `;
    })
    .join("");
}

function setUser(user) {
  const loggedIn = Boolean(user);
  authPanel.classList.toggle("hidden", loggedIn);
  appPanel.classList.toggle("hidden", !loggedIn);
  sessionChip.textContent = loggedIn ? user.username : "未登录";
  setStatus("");
}

function setStatus(message) {
  statusLine.textContent = message || "";
}

async function requestJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, error: data.error || "请求失败" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "网络请求失败" };
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

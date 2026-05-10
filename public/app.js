const authPanel = document.querySelector("#authPanel");
const appPanel = document.querySelector("#appPanel");
const adminPanel = document.querySelector("#adminPanel");
const authForm = document.querySelector("#authForm");
const uploadForm = document.querySelector("#uploadForm");
const authSubmit = document.querySelector("#authSubmit");
const logoutButton = document.querySelector("#logoutButton");
const statusLine = document.querySelector("#statusLine");
const sessionChip = document.querySelector("#sessionChip");
const fileList = document.querySelector("#fileList");
const userList = document.querySelector("#userList");
const fileInput = uploadForm.elements.attachment;
const fileLabel = document.querySelector("#fileLabel");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const dateLine = document.querySelector("#dateLine");
const playbackRates = [0.5, 1, 1.25, 1.5, 2, 3];

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
  if (result.data.user.role === "admin") await loadAdminUsers();
});

logoutButton.addEventListener("click", async () => {
  await requestJson("/api/logout", { method: "POST" });
  setUser(null);
  fileList.innerHTML = "";
  userList.innerHTML = "";
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
  await loadAdminUsersIfNeeded();
});

const me = await requestJson("/api/me");
setUser(me.ok ? me.data.user : null);
if (me.ok && me.data.user) {
  await loadFiles();
  if (me.data.user.role === "admin") await loadAdminUsers();
}

fileList.addEventListener("click", (event) => {
  const button = event.target.closest(".speed-button");
  if (!button) return;

  const video = document.getElementById(button.dataset.videoId);
  if (!video) return;

  video.playbackRate = Number(button.dataset.rate);
  button
    .closest(".speed-controls")
    .querySelectorAll(".speed-button")
    .forEach((item) => item.classList.toggle("active", item === button));
});

userList.addEventListener("submit", async (event) => {
  const form = event.target.closest(".password-form");
  if (!form) return;

  event.preventDefault();
  const username = form.dataset.username;
  const password = form.elements.password.value;
  const result = await requestJson(`/api/admin/users/${encodeURIComponent(username)}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });

  if (!result.ok) {
    setStatus(result.error);
    return;
  }

  form.reset();
  setStatus("密码已修改");
});

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

      const preview = renderPreview(file);

      return `
        <article class="file-row">
          <div class="file-name">${escapeHtml(file.originalName)}</div>
          <div class="file-meta">${formatBytes(file.size)}</div>
          <a href="/api/files/${file.id}/download">下载</a>
          <div class="file-meta">${uploadedAt}</div>
          ${preview}
        </article>
      `;
    })
    .join("");
}

function setUser(user) {
  const loggedIn = Boolean(user);
  authPanel.classList.toggle("hidden", loggedIn);
  appPanel.classList.toggle("hidden", !loggedIn);
  adminPanel.classList.toggle("hidden", !loggedIn || user.role !== "admin");
  sessionChip.textContent = loggedIn ? `${user.username}${user.role === "admin" ? " 管理员" : ""}` : "未登录";
  setStatus("");
}

async function loadAdminUsersIfNeeded() {
  if (!adminPanel.classList.contains("hidden")) await loadAdminUsers();
}

async function loadAdminUsers() {
  const result = await requestJson("/api/admin/users");
  if (!result.ok) {
    setStatus(result.error);
    return;
  }

  renderUsers(result.data.users);
}

function renderUsers(users) {
  if (!users.length) {
    userList.innerHTML = '<div class="empty-state">还没有用户</div>';
    return;
  }

  userList.innerHTML = users
    .map((user) => {
      const createdAt = user.createdAt
        ? new Intl.DateTimeFormat("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(user.createdAt))
        : "";

      return `
        <form class="user-row password-form" data-username="${escapeHtml(user.username)}">
          <div>
            <div class="user-name">${escapeHtml(user.username)}</div>
            <div class="file-meta">${user.role === "admin" ? "管理员" : "用户"}</div>
          </div>
          <div class="file-meta">${createdAt}</div>
          <div class="file-meta">${user.fileCount} 个附件</div>
          <label class="inline-field">
            <span>新密码</span>
            <input name="password" type="password" autocomplete="new-password" minlength="8" required>
          </label>
          <button class="text-button" type="submit">修改密码</button>
        </form>
      `;
    })
    .join("");
}

function renderPreview(file) {
  const mimeType = file.mimeType || "";
  const source = `/api/files/${file.id}/content`;

  if (mimeType.startsWith("image/")) {
    return `
      <div class="file-preview">
        <img class="preview-image" src="${source}" alt="${escapeHtml(file.originalName)}">
      </div>
    `;
  }

  if (mimeType.startsWith("video/")) {
    const videoId = `video-${file.id}`;
    const buttons = playbackRates
      .map((rate) => {
        const active = rate === 1 ? " active" : "";
        return `<button class="speed-button${active}" type="button" data-video-id="${videoId}" data-rate="${rate}">${rate}x</button>`;
      })
      .join("");

    return `
      <div class="file-preview">
        <video class="preview-video" id="${videoId}" src="${source}" controls preload="metadata" playsinline></video>
        <div class="speed-controls" aria-label="播放速度">${buttons}</div>
      </div>
    `;
  }

  return "";
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

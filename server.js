import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "uploads"));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FILES_FILE = path.join(DATA_DIR, "files.json");
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const app = express();
const sessions = new Map();

app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

await ensureStorage();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const userDir = path.join(UPLOAD_DIR, req.user.username);
        await fs.mkdir(userDir, { recursive: true });
        cb(null, userDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const safeName = sanitizeFilename(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomUUID()}-${safeName}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

app.get("/api/me", requireSessionOptional, (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }

  res.json({ user: userResponse(req.user) });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/register", async (req, res) => {
  const { username, password } = readCredentials(req.body);
  const validationError = validateCredentials(username, password);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const users = await readJson(USERS_FILE, {});
  const normalized = username.toLowerCase();
  if (users[normalized]) {
    res.status(409).json({ error: "账号已存在" });
    return;
  }

  users[normalized] = {
    username,
    password: hashPassword(password),
    role: Object.keys(users).length === 0 ? "admin" : "user",
    createdAt: new Date().toISOString()
  };
  await writeJson(USERS_FILE, users);
  setSession(res, normalized, username, users[normalized].role);
  res.status(201).json({ user: userResponse({ username: normalized, displayName: username, role: users[normalized].role }) });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = readCredentials(req.body);
  const normalized = username.toLowerCase();
  const users = await readJson(USERS_FILE, {});
  const user = users[normalized];

  if (!user || !verifyPassword(password, user.password)) {
    res.status(401).json({ error: "账号或密码不正确" });
    return;
  }

  const role = normalizeRole(user.role);
  setSession(res, normalized, user.username, role);
  res.json({ user: userResponse({ username: normalized, displayName: user.username, role }) });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", cookieHeader("session", "", { maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/files", requireSession, async (req, res) => {
  const files = await readJson(FILES_FILE, []);
  res.json({
    files: files
      .filter((file) => file.owner === req.user.key)
      .map(publicFile)
  });
});

app.post("/api/upload", requireSession, upload.single("attachment"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "请选择附件" });
    return;
  }

  const files = await readJson(FILES_FILE, []);
  const record = {
    id: crypto.randomUUID(),
    owner: req.user.key,
    originalName: req.file.originalname,
    storedName: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  files.push(record);
  await writeJson(FILES_FILE, files);
  res.status(201).json({
    file: publicFile(record)
  });
});

app.get("/api/files/:id/content", requireSession, async (req, res) => {
  const file = await findOwnedFile(req.params.id, req.user.key);
  if (!file) {
    res.status(404).json({ error: "文件不存在" });
    return;
  }

  res.type(detectMimeType(file));
  res.sendFile(path.join(UPLOAD_DIR, req.user.username, file.storedName));
});

app.get("/api/files/:id/download", requireSession, async (req, res) => {
  const file = await findOwnedFile(req.params.id, req.user.key);
  if (!file) {
    res.status(404).json({ error: "文件不存在" });
    return;
  }

  res.download(path.join(UPLOAD_DIR, req.user.username, file.storedName), file.originalName);
});

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  const users = await readJson(USERS_FILE, {});
  const files = await readJson(FILES_FILE, []);

  res.json({
    users: Object.entries(users).map(([key, user]) => ({
      username: user.username || key,
      role: normalizeRole(user.role),
      createdAt: user.createdAt || null,
      fileCount: files.filter((file) => file.owner === key).length
    }))
  });
});

app.post("/api/admin/users/:username/password", requireAdmin, async (req, res) => {
  const targetKey = String(req.params.username || "").toLowerCase();
  const password = String(req.body?.password || "");
  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const users = await readJson(USERS_FILE, {});
  if (!users[targetKey]) {
    res.status(404).json({ error: "账号不存在" });
    return;
  }

  users[targetKey].password = hashPassword(password);
  await writeJson(USERS_FILE, users);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "附件不能超过 100MB" });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "服务器错误" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await writeJsonIfMissing(USERS_FILE, {});
  await writeJsonIfMissing(FILES_FILE, []);
  await ensureUserRoles();
}

async function ensureUserRoles() {
  const users = await readJson(USERS_FILE, {});
  const entries = Object.entries(users);
  if (!entries.length) return;

  let changed = false;
  for (const [, user] of entries) {
    if (!user.role) {
      user.role = "user";
      changed = true;
    }
  }

  if (!entries.some(([, user]) => normalizeRole(user.role) === "admin")) {
    const [firstKey] = entries.sort(([, left], [, right]) => {
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    })[0];
    users[firstKey].role = "admin";
    changed = true;
  }

  if (changed) await writeJson(USERS_FILE, users);
}

async function writeJsonIfMissing(file, value) {
  try {
    await fs.access(file);
  } catch {
    await writeJson(file, value);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const tempFile = `${file}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempFile, file);
}

function readCredentials(body) {
  return {
    username: String(body?.username || "").trim(),
    password: String(body?.password || "")
  };
}

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return "账号需要 3-32 位，只能包含字母、数字、下划线和连字符";
  }

  return validatePassword(password);
}

function validatePassword(password) {
  if (password.length < 8) {
    return "密码至少 8 位";
  }

  return "";
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 64, "sha512").toString("hex");
  return `pbkdf2$210000$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored || "").split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !expected) {
    return false;
  }

  const actual = crypto.pbkdf2Sync(password, salt, Number(iterations), 64, "sha512");
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

function setSession(res, userKey, username, role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userKey, username, role, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
  res.setHeader("Set-Cookie", cookieHeader("session", token, { maxAge: 60 * 60 * 24 * 7 }));
}

function requireSessionOptional(req, res, next) {
  const token = parseCookies(req.headers.cookie).session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    next();
    return;
  }

  req.user = {
    key: session.userKey,
    username: session.userKey,
    displayName: session.username,
    role: normalizeRole(session.role)
  };
  next();
}

function requireSession(req, res, next) {
  requireSessionOptional(req, res, () => {
    if (!req.user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }

    next();
  });
}

function requireAdmin(req, res, next) {
  requireSession(req, res, () => {
    if (req.user.role !== "admin") {
      res.status(403).json({ error: "需要管理员权限" });
      return;
    }

    next();
  });
}

async function findOwnedFile(id, owner) {
  const files = await readJson(FILES_FILE, []);
  return files.find((item) => item.id === id && item.owner === owner);
}

function publicFile(file) {
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: detectMimeType(file),
    size: file.size,
    uploadedAt: file.uploadedAt
  };
}

function detectMimeType(file) {
  if (file.mimeType) return file.mimeType;

  const extension = path.extname(file.originalName || "").toLowerCase();
  return (
    {
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".mov": "video/quicktime",
      ".mp4": "video/mp4",
      ".ogg": "video/ogg",
      ".png": "image/png",
      ".webm": "video/webm",
      ".webp": "image/webp"
    }[extension] || "application/octet-stream"
  );
}

function userResponse(user) {
  return {
    username: user.displayName || user.username,
    role: normalizeRole(user.role)
  };
}

function normalizeRole(role) {
  return role === "admin" ? "admin" : "user";
}

function parseCookies(cookie = "") {
  return Object.fromEntries(
    cookie
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)])
  );
}

function cookieHeader(name, value, options = {}) {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (process.env.NODE_ENV === "production") parts.push("Secure");
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function sanitizeFilename(filename) {
  const parsed = path.parse(filename || "attachment");
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16);
  return `${base.slice(0, 80)}${ext}`;
}

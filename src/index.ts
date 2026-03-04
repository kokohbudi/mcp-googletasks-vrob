#!/usr/bin/env node
// src/index.ts — Google Tasks MCP vrob (robust, persistent OAuth2)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { OAuth2Client, Credentials } from "google-auth-library";
import * as http from "http";
import * as net from "net";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { URL } from "url";

// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_PORT = parseInt(process.env.OAUTH_PORT ?? "3000", 10);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/tasks"];
const CREDS_PATH = path.join(
  os.homedir(),
  ".config",
  "mcp-googletasks-vrob",
  "credentials.json",
);
// Token is refreshed proactively when < TOKEN_EXPIRY_BUFFER_MS remaining
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("FATAL: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  process.exit(1);
}

// ─── OAuth2 client ─────────────────────────────────────────────────────────

const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Auto-save whenever the library internally refreshes the token
oauth2Client.on("tokens", async (tokens) => {
  try {
    const existing = await loadCreds();
    // Merge: keep old refresh_token if new one is not returned
    const merged: Credentials = {
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token ?? existing?.refresh_token,
    };
    await saveCreds(merged);
    oauth2Client.setCredentials(merged);
  } catch (e) {
    console.error("[auth] Failed to persist refreshed token:", e);
  }
});

// ─── Credential persistence ─────────────────────────────────────────────────

async function loadCreds(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(CREDS_PATH, "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

async function saveCreds(creds: Credentials): Promise<void> {
  await fs.mkdir(path.dirname(CREDS_PATH), { recursive: true });
  await fs.writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

async function deleteCreds(): Promise<void> {
  try {
    await fs.unlink(CREDS_PATH);
  } catch {
    // already gone, fine
  }
}

// ─── Token lifecycle ────────────────────────────────────────────────────────

/**
 * Ensure the OAuth2 client has a valid, non-expired token.
 * Throws if not authenticated or if the refresh token is invalid.
 */
async function ensureAuthenticated(): Promise<void> {
  const creds = oauth2Client.credentials;
  if (!creds?.access_token && !creds?.refresh_token) {
    throw new AuthError(
      "Not authenticated. Use the 'authenticate' tool to log in.",
    );
  }

  const now = Date.now();
  const expiry = creds.expiry_date ?? 0;
  const needsRefresh =
    !creds.access_token || expiry - now < TOKEN_EXPIRY_BUFFER_MS;

  if (needsRefresh) {
    if (!creds.refresh_token) {
      throw new AuthError(
        "Access token expired and no refresh token available. Please re-authenticate.",
      );
    }
    try {
      const { credentials: fresh } = await oauth2Client.refreshAccessToken();
      const merged: Credentials = {
        ...creds,
        ...fresh,
        refresh_token: fresh.refresh_token ?? creds.refresh_token,
      };
      oauth2Client.setCredentials(merged);
      await saveCreds(merged);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("invalid_grant") ||
        msg.includes("Token has been expired or revoked")
      ) {
        await deleteCreds();
        throw new AuthError(
          "Refresh token expired or revoked. Please re-authenticate using the 'authenticate' tool.",
        );
      }
      throw e; // transient network error — let caller retry
    }
  }
}

class AuthError extends Error {
  readonly isAuthError = true;
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

// ─── Startup: load persisted credentials ───────────────────────────────────

async function init(): Promise<void> {
  const saved = await loadCreds();
  if (!saved) return;

  oauth2Client.setCredentials(saved);

  // Eagerly refresh if close to expiry — fail silently (transient errors are OK)
  try {
    await ensureAuthenticated();
    console.error("[auth] Loaded saved credentials — ready.");
  } catch (e) {
    if (isAuthError(e)) {
      console.error("[auth]", e.message);
    } else {
      console.error(
        "[auth] Transient error on startup refresh, will retry on first call:",
        e,
      );
    }
  }
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new McpServer({ name: "google-tasks-vrob", version: "1.0.0" });
const tasksApi = google.tasks({ version: "v1", auth: oauth2Client });

// ─── Shared helpers ─────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

async function guardedCall<T>(fn: () => Promise<T>): Promise<T> {
  await ensureAuthenticated();
  return fn();
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const ListId = z.string().min(1).max(200);
const TaskId = z.string().min(1).max(200);
const Title = z.string().min(1).max(1024).trim();
const Notes = z.string().max(8192).optional();
const DueDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
    "Must be RFC 3339, e.g. 2025-03-19T12:00:00Z",
  )
  .optional();

// ─── AUTH TOOLS ─────────────────────────────────────────────────────────────

let authServer: http.Server | null = null;

server.registerTool(
  "authenticate",
  {
    title: "Authenticate with Google Tasks",
    description:
      "Start OAuth2 flow. Opens a local callback server, returns the auth URL to visit. After you approve, credentials are saved automatically — you won't need to log in again.",
    inputSchema: z.object({}),
  },
  async () => {
    // Close any stale auth server
    authServer?.close();
    authServer = null;

    // Find a free port
    const port = await findFreePort(REDIRECT_PORT);
    const redirectUri = `http://localhost:${port}/oauth2callback`;
    const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri);

    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent", // always get refresh_token
    });

    return new Promise((resolve) => {
      authServer = http.createServer(async (req, res) => {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const code = reqUrl.searchParams.get("code");

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>No code received.</h1>");
          resolve(err("OAuth callback received no code."));
          return;
        }

        try {
          const { tokens } = await client.getToken(code);
          oauth2Client.setCredentials(tokens);
          await saveCreds(tokens);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<h1 style="color:green">✅ Authenticated!</h1><p>You can close this tab. Claude is ready, ask claude to continue</p>`,
          );

          setTimeout(() => {
            authServer?.close();
            authServer = null;
          }, 3000);
          resolve(
            ok(
              "Authentication successful! Credentials saved. You won't need to log in again unless the token is revoked.",
            ),
          );
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(
            `<h1>Token exchange failed</h1><pre>${escHtml(formatError(e))}</pre>`,
          );
          resolve(err(`Token exchange failed: ${formatError(e)}`));
        }
      });

      authServer.listen(port, () => {
        console.error(`[auth] Callback server listening on port ${port}`);
        resolve(
          ok(
            `Visit this URL to authenticate:\n\n${authUrl}\n\nAfter approving, this window will update automatically.`,
          ),
        );
      });

      authServer.on("error", (e) => {
        resolve(err(`Failed to start callback server: ${formatError(e)}`));
      });
    });
  },
);

server.registerTool(
  "auth-status",
  {
    title: "Check Authentication Status",
    description:
      "Check whether Google Tasks is authenticated and when the token expires.",
    inputSchema: z.object({}),
  },
  async () => {
    const creds = oauth2Client.credentials;
    if (!creds?.access_token && !creds?.refresh_token) {
      return ok("Not authenticated. Use the 'authenticate' tool.");
    }
    const expiry = creds.expiry_date
      ? new Date(creds.expiry_date).toISOString()
      : "unknown";
    const hasRefresh = !!creds.refresh_token;
    return ok(
      `Authenticated ✅\n` +
        `Access token expires: ${expiry}\n` +
        `Refresh token: ${hasRefresh ? "present (auto-refresh enabled)" : "missing — may need re-auth"}`,
    );
  },
);

server.registerTool(
  "logout",
  {
    title: "Logout / Revoke Credentials",
    description:
      "Revoke the current Google OAuth token and delete saved credentials.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const creds = oauth2Client.credentials;
      if (creds?.access_token) {
        await oauth2Client.revokeToken(creds.access_token);
      }
    } catch {
      // best-effort revoke
    }
    oauth2Client.setCredentials({});
    await deleteCreds();
    return ok("Logged out. Saved credentials removed.");
  },
);

// ─── TASK LIST TOOLS ─────────────────────────────────────────────────────────

server.registerTool(
  "list-tasklists",
  {
    title: "List Task Lists",
    description: "List all task lists",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const res = await guardedCall(() => tasksApi.tasklists.list());
      const lists = (res.data.items ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        updated: l.updated,
      }));
      return ok(
        lists.length ? JSON.stringify(lists, null, 2) : "No task lists found.",
      );
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "get-tasklist",
  {
    title: "Get Task List",
    description: "Get a task list by ID",
    inputSchema: z.object({ tasklist: ListId.describe("Task list ID") }),
  },
  async ({ tasklist }) => {
    try {
      const res = await guardedCall(() => tasksApi.tasklists.get({ tasklist }));
      return ok(JSON.stringify(res.data, null, 2));
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "create-tasklist",
  {
    title: "Create Task List",
    description: "Create a new task list",
    inputSchema: z.object({
      title: Title.describe("Title of the new task list"),
    }),
  },
  async ({ title }) => {
    try {
      const res = await guardedCall(() =>
        tasksApi.tasklists.insert({ requestBody: { title } }),
      );
      return ok(`Task list created:\n${JSON.stringify(res.data, null, 2)}`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "update-tasklist",
  {
    title: "Update Task List",
    description: "Update an existing task list",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      title: Title.describe("New title"),
    }),
  },
  async ({ tasklist, title }) => {
    try {
      const current = await guardedCall(() =>
        tasksApi.tasklists.get({ tasklist }),
      );
      const res = await tasksApi.tasklists.update({
        tasklist,
        requestBody: { ...current.data, title },
      });
      return ok(`Task list updated:\n${JSON.stringify(res.data, null, 2)}`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "delete-tasklist",
  {
    title: "Delete Task List",
    description: "Delete a task list",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID to delete"),
    }),
  },
  async ({ tasklist }) => {
    try {
      await guardedCall(() => tasksApi.tasklists.delete({ tasklist }));
      return ok(`Task list '${tasklist}' deleted.`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

// ─── TASK TOOLS ──────────────────────────────────────────────────────────────

server.registerTool(
  "list-tasks",
  {
    title: "List Tasks",
    description: "List all tasks in a task list",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      showCompleted: z
        .boolean()
        .optional()
        .describe("Include completed tasks (default: true)"),
      showHidden: z
        .boolean()
        .optional()
        .describe("Include hidden tasks (default: false)"),
      showDeleted: z
        .boolean()
        .optional()
        .describe("Include deleted tasks (default: false)"),
    }),
  },
  async ({ tasklist, showCompleted, showHidden, showDeleted }) => {
    try {
      const res = await guardedCall(() =>
        tasksApi.tasks.list({
          tasklist,
          showCompleted: showCompleted ?? true,
          showHidden: showHidden ?? false,
          showDeleted: showDeleted ?? false,
        }),
      );
      const items = (res.data.items ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due: t.due,
        notes: t.notes,
        completed: t.completed,
      }));
      return ok(
        items.length ? JSON.stringify(items, null, 2) : "No tasks found.",
      );
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "get-task",
  {
    title: "Get Task",
    description: "Get a specific task by ID",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      task: TaskId.describe("Task ID"),
    }),
  },
  async ({ tasklist, task }) => {
    try {
      const res = await guardedCall(() =>
        tasksApi.tasks.get({ tasklist, task }),
      );
      return ok(JSON.stringify(res.data, null, 2));
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "create-task",
  {
    title: "Create Task",
    description: "Create a new task in a task list",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      title: Title.describe("Task title"),
      notes: Notes.describe("Optional notes"),
      due: DueDate.describe(
        "Due date in RFC 3339 format (e.g., 2025-03-19T12:00:00Z)",
      ),
    }),
  },
  async ({ tasklist, title, notes, due }) => {
    try {
      const requestBody: Record<string, string> = {
        title,
        status: "needsAction",
      };
      if (notes) requestBody.notes = notes;
      if (due) requestBody.due = due;
      const res = await guardedCall(() =>
        tasksApi.tasks.insert({ tasklist, requestBody }),
      );
      return ok(`Task created:\n${JSON.stringify(res.data, null, 2)}`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "update-task",
  {
    title: "Update Task",
    description: "Update an existing task (only provided fields are changed)",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      task: TaskId.describe("Task ID"),
      title: Title.optional().describe("New title"),
      notes: Notes.describe("New notes"),
      status: z
        .enum(["needsAction", "completed"])
        .optional()
        .describe("Task status"),
      due: DueDate.describe("Due date in RFC 3339 format"),
    }),
  },
  async ({ tasklist, task, title, notes, status, due }) => {
    try {
      const current = await guardedCall(() =>
        tasksApi.tasks.get({ tasklist, task }),
      );
      const requestBody = { ...current.data };
      if (title !== undefined) requestBody.title = title;
      if (notes !== undefined) requestBody.notes = notes;
      if (status !== undefined) requestBody.status = status;
      if (due !== undefined) requestBody.due = due;
      const res = await tasksApi.tasks.update({ tasklist, task, requestBody });
      return ok(`Task updated:\n${JSON.stringify(res.data, null, 2)}`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "delete-task",
  {
    title: "Delete Task",
    description: "Delete a task",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      task: TaskId.describe("Task ID to delete"),
    }),
  },
  async ({ tasklist, task }) => {
    try {
      await guardedCall(() => tasksApi.tasks.delete({ tasklist, task }));
      return ok(`Task '${task}' deleted.`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "complete-task",
  {
    title: "Complete Task",
    description: "Mark a task as completed",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      task: TaskId.describe("Task ID"),
    }),
  },
  async ({ tasklist, task }) => {
    try {
      const current = await guardedCall(() =>
        tasksApi.tasks.get({ tasklist, task }),
      );
      const requestBody = {
        ...current.data,
        status: "completed",
        completed: new Date().toISOString(),
      };
      const res = await tasksApi.tasks.update({ tasklist, task, requestBody });
      return ok(
        `Task marked as completed:\n${JSON.stringify(res.data, null, 2)}`,
      );
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "move-task",
  {
    title: "Move Task",
    description: "Move a task to another position",
    inputSchema: z.object({
      tasklist: ListId.describe("Task list ID"),
      task: TaskId.describe("Task ID to move"),
      parent: TaskId.optional().describe(
        "New parent task ID (omit for top-level)",
      ),
      previous: TaskId.optional().describe("Previous sibling task ID"),
    }),
  },
  async ({ tasklist, task, parent, previous }) => {
    try {
      const params: Record<string, string> = { tasklist, task };
      if (parent) params.parent = parent;
      if (previous) params.previous = previous;
      const res = await guardedCall(() => tasksApi.tasks.move(params));
      return ok(`Task moved:\n${JSON.stringify(res.data, null, 2)}`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

server.registerTool(
  "clear-completed-tasks",
  {
    title: "Clear Completed Tasks",
    description: "Clear all completed tasks from a task list",
    inputSchema: z.object({ tasklist: ListId.describe("Task list ID") }),
  },
  async ({ tasklist }) => {
    try {
      await guardedCall(() => tasksApi.tasks.clear({ tasklist }));
      return ok(`All completed tasks cleared from '${tasklist}'.`);
    } catch (e) {
      return isAuthError(e) ? err(e.message) : err(`Error: ${formatError(e)}`);
    }
  },
);

// ─── Utilities ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findFreePort(start: number, attempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let tried = 0;
    const tryPort = (p: number) => {
      const s = net.createServer();
      s.listen(p, () => {
        s.close(() => resolve(p));
      });
      s.on("error", () => {
        if (++tried >= attempts)
          reject(
            new Error(`No free port in range ${start}–${start + attempts}`),
          );
        else tryPort(p + 1);
      });
    };
    tryPort(start);
  });
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.error(`[server] ${signal} received, shutting down`);
  authServer?.close();
  try {
    await server.close();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main() {
  await init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Google Tasks MCP vrob running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

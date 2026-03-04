# Google Tasks MCP Server (vrob)

A robust, persistent Model Context Protocol (MCP) server for Google Tasks with seamless OAuth2 flow and reliable token refresh capabilities. This server allows AI agents (like Claude) to securely authenticate with Google Tasks and perform full CRUD operations on Task Lists and Tasks.

## Features

- 🔐 **Persistent OAuth2 Authentication**: Authenticate once, the token is saved securely and automatically refreshed in the background.
- 🔄 **Auto-Refresh Tokens**: Avoids common "token expired" issues.
- 📋 **Full CRUD for Task Lists**: Create, read, update, and delete task lists.
- ✅ **Full CRUD for Tasks**: Create, read, update status (completed/needsAction), and delete specific tasks.
- 📦 **Move & Clear**: Change task positions or clear all completed tasks.

## Prerequisites

- Node.js >= 20.0.0
- NPM or PNPM
- Google Cloud Console account

## Step-by-Step Guide

### Step 1: Set Up Google Cloud Console

To use this MCP server, you need to create OAuth2 credentials from Google Cloud.

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a **New Project** (or select an existing one).
3. In the navigation menu, go to **APIs & Services > Library**.
4. Search for **Google Tasks API**, then click **Enable**.
5. Go to **APIs & Services > OAuth consent screen**:
   - Select **External** (or Internal if you are using a Google Workspace).
   - Fill in the app name (e.g., "MCP Tasks"), user support email, and developer contact information.
   - In the Scopes section, click **Add or Remove Scopes**, then search for and add the `https://www.googleapis.com/auth/tasks` scope.
   - Add your own email in the **Test users** section (Required if the publishing status is set to "Testing").
6. Go to **APIs & Services > Credentials**:
   - Click **Create Credentials > OAuth client ID**.
   - Application type: Select **Web application**.
   - Name: "MCP Server" (or anything you prefer).
   - Authorized redirect URIs: Add `http://localhost:3000/oauth2callback`. (You can change the port using `.env` if necessary).
   - Click **Create**.
7. You will get a **Client ID** and a **Client Secret**. Save them!

### Step 2: Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/kokohbudi/mcp-googletasks-vrob.git
   cd mcp-googletasks-vrob
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

### Step 3: Configure Claude / Your MCP Client

For Claude to use this MCP server, you must add the configuration to your Claude settings file (e.g., `claude_desktop_config.json` or via the Claude CLI).

Add the following configuration, making sure to replace `<YOUR_CLIENT_ID>` and `<YOUR_CLIENT_SECRET>` with the credentials you obtained in Step 1:

```json
{
  "mcpServers": {
    "google-tasks-vrob": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-googletasks-vrob/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "<YOUR_CLIENT_ID>",
        "GOOGLE_CLIENT_SECRET": "<YOUR_CLIENT_SECRET>",
        "OAUTH_PORT": "3000"
      }
    }
  }
}
```
*Note: Change `/absolute/path/to/...` to the actual path where this repository is located on your local machine.*

### Step 4: Authentication & Usage

1. Run your AI app/Claude. This MCP server will be loaded automatically.
2. For the very first usage, ask the AI (Claude) to log in using a prompt like:
   > "Please authenticate with Google Tasks"
3. Claude will call the `authenticate` tool and provide you with a URL.
4. Open the URL in your web browser, select your Google account, grant permission, and you will see an **"✅ Authenticated!"** message.
5. That's it! You can now ask Claude to manage your tasks. For example:
   - "List all my task lists."
   - "Create a new task named 'Weekly Groceries' and put it in the 'Personal' list."
   - "Mark the 'Weekly Groceries' task as completed."

## List of Tools Available

This server exposes the following MCP tools:

**Authentication Tools:**
- `authenticate`: Start the OAuth2 flow to log in.
- `auth-status`: Check the current token status.
- `logout`: Revoke the token and remove local credentials.

**Task List Tools:**
- `list-tasklists`: List all task lists.
- `get-tasklist`: Retrieve details of a specific task list.
- `create-tasklist`: Create a new task list.
- `update-tasklist`: Rename a task list.
- `delete-tasklist`: Delete a task list.

**Task Tools:**
- `list-tasks`: List tasks within a specific task list.
- `get-task`: Retrieve details of a specific task.
- `create-task`: Create a new task.
- `update-task`: Change a task's notes, due date, title, or status.
- `delete-task`: Delete a task.
- `complete-task`: Instantly mark a task as completed.
- `move-task`: Move a task's position within a list.
- `clear-completed-tasks`: Delete all completed tasks from a list.

## Local Credentials Storage

After a successful login, your OAuth2 credentials and Refresh Token are securely saved on your local machine:
- macOS/Linux: `~/.config/mcp-googletasks-vrob/credentials.json`
- Windows: `%USERPROFILE%\.config\mcp-googletasks-vrob\credentials.json`

## License
MIT
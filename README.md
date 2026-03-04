# Google Tasks MCP Server (vrob)

A robust, persistent Model Context Protocol (MCP) server for Google Tasks with seamless OAuth2 flow and reliable token refresh capabilities. This server allows AI agents (like Claude) to securely authenticate with Google Tasks and perform full CRUD operations on Task Lists and Tasks.

## Features

- 🔐 **Persistent OAuth2 Authentication**: Authenticasi satu kali, token akan disimpan secara aman dan otomatis direfresh di latar belakang.
- 🔄 **Auto-Refresh Tokens**: Menghindari masalah "token expired" yang umum terjadi.
- 📋 **Full CRUD for Task Lists**: Buat, baca, perbarui, dan hapus daftar tugas.
- ✅ **Full CRUD for Tasks**: Buat, baca, perbarui status (selesai/belum selesai), dan hapus tugas spesifik.
- 📦 **Move & Clear**: Pindahkan posisi tugas atau hapus seluruh tugas yang sudah selesai.

## Prerequisites

- Node.js >= 20.0.0
- NPM atau PNPM
- Google Cloud Console account

## Step-by-Step Guide

### Step 1: Set Up Google Cloud Console

Untuk menggunakan server MCP ini, Anda perlu membuat kredensial OAuth2 dari Google Cloud.

1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Buat **Project Baru** (atau pilih project yang sudah ada).
3. Di menu navigasi, buka **APIs & Services > Library**.
4. Cari **Google Tasks API**, lalu klik **Enable**.
5. Buka **APIs & Services > OAuth consent screen**:
   - Pilih **External** (atau Internal jika Anda menggunakan Google Workspace).
   - Isi nama aplikasi (misal: "MCP Tasks"), email pengguna, dan email developer.
   - Di bagian Scopes, klik **Add or Remove Scopes**, lalu cari dan tambahkan scope `https://www.googleapis.com/auth/tasks`.
   - Tambahkan email Anda sendiri di bagian **Test users** (Wajib jika status aplikasi adalah "Testing").
6. Buka **APIs & Services > Credentials**:
   - Klik **Create Credentials > OAuth client ID**.
   - Application type: Pilih **Web application**.
   - Name: "MCP Server" (atau apa saja).
   - Authorized redirect URIs: Tambahkan `http://localhost:3000/oauth2callback`. (Anda dapat menyesuaikan port di `.env` jika perlu).
   - Klik **Create**.
7. Anda akan mendapatkan **Client ID** dan **Client Secret**. Simpan keduanya!

### Step 2: Installation

1. Clone repositori ini:
   ```bash
   git clone https://github.com/kokohbudi/mcp-googletasks-vrob.git
   cd mcp-googletasks-vrob
   ```

2. Install dependensi:
   ```bash
   npm install
   ```

3. Build project:
   ```bash
   npm run build
   ```

### Step 3: Konfigurasi Claude / Aplikasi MCP Anda

Agar Claude dapat menggunakan server MCP ini, Anda perlu menambahkan konfigurasinya di file pengaturan Claude Anda (misalnya: `claude_desktop_config.json` atau melalui CLI Claude).

Tambahkan konfigurasi berikut, pastikan untuk mengganti `<YOUR_CLIENT_ID>` dan `<YOUR_CLIENT_SECRET>` dengan yang Anda dapatkan di Langkah 1:

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
*Catatan: Ubah `/absolute/path/to/...` dengan direktori sebenarnya tempat repositori ini berada di komputer Anda.*

### Step 4: Authentication & Penggunaan

1. Jalankan aplikasi AI/Claude Anda. Server MCP ini akan dimuat secara otomatis.
2. Saat pertama kali digunakan, minta AI (Claude) untuk melakukan login dengan perintah seperti:
   > "Please authenticate with Google Tasks"
3. Claude akan memanggil tools `authenticate` dan memberikan Anda sebuah URL.
4. Buka URL tersebut di browser web, pilih akun Google Anda, berikan izin, dan Anda akan melihat pesan **"✅ Authenticated!"**.
5. Selesai! Anda sekarang dapat meminta Claude untuk mengelola tugas Anda, misalnya:
   - "Tampilkan semua task list saya."
   - "Buat task baru bernama 'Belanja Mingguan' dan masukkan ke list 'Personal'."
   - "Tandai task 'Belanja Mingguan' sebagai selesai."

## List of Tools Available

Server ini mengekspos beberapa MCP tools berikut:

**Authentication Tools:**
- `authenticate`: Memulai flow OAuth2 untuk login.
- `auth-status`: Mengecek status token saat ini.
- `logout`: Mencabut token dan menghapus sesi.

**Task List Tools:**
- `list-tasklists`: Menampilkan semua task list.
- `get-tasklist`: Mengambil detail sebuah task list.
- `create-tasklist`: Membuat task list baru.
- `update-tasklist`: Mengubah judul task list.
- `delete-tasklist`: Menghapus task list.

**Task Tools:**
- `list-tasks`: Menampilkan task dalam list tertentu.
- `get-task`: Mengambil detail task tertentu.
- `create-task`: Membuat task baru.
- `update-task`: Mengubah catatan, tanggal, judul, atau status task.
- `delete-task`: Menghapus task.
- `complete-task`: Menandai task sudah selesai secara instan.
- `move-task`: Mengubah posisi task di dalam list.
- `clear-completed-tasks`: Menghapus semua task yang telah diselesaikan.

## File Penyimpanan Kredensial Lokal

Setelah login, kredensial OAuth2 dan Refresh Token disimpan secara aman di mesin lokal Anda:
- macOS/Linux: `~/.config/mcp-googletasks-vrob/credentials.json`
- Windows: `%USERPROFILE%\.config\mcp-googletasks-vrob\credentials.json`

## License
MIT

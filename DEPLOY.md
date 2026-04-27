# 🚀 Panduan Deploy VPS (Ubuntu) - Bot Store WhatsApp

Ikuti langkah-langkah berikut untuk menjalankan bot di VPS Ubuntu agar stabil dan jalan 24 jam.

## 1. Persiapan Awal
Pastikan VPS sudah terinstall Node.js (v18 ke atas) dan Git.

```bash
# Update package
sudo apt update && sudo apt upgrade -y

# Install Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Install PM2 (Process Manager)
Agar bot tetap jalan jika terminal ditutup atau VPS restart.
```bash
sudo npm install pm2 -g
```

## 3. Persiapan File Bot
Upload semua file bot ke VPS (bisa via GitHub atau FileZilla), lalu masuk ke folder bot:
```bash
cd botwa
npm install
```

## 4. Menjalankan Bot
Gunakan PM2 untuk menjalankan bot sesuai konfigurasi `ecosystem.config.js` yang sudah saya buatkan:
```bash
pm2 start ecosystem.config.js
```

### Command Penting PM2:
- `pm2 status` : Cek status bot.
- `pm2 logs botwa` : Lihat log/scan QR Code.
- `pm2 restart botwa` : Restart bot.
- `pm2 stop botwa` : Hentikan bot.

## 5. Fitur Unggulan VPS (Sudah Terpasang)
- **Low RAM Optimization**: Bot hanya memakan RAM sekitar 100-200MB.
- **Auto Restart**: Jika bot error/crash, PM2 akan otomatis menjalankannya lagi.
- **Max Memory Limit**: Bot akan restart otomatis jika penggunaan RAM melebihi 300MB (mencegah VPS hang).
- **Debounced DB**: Penyimpanan database efisien, tidak memberatkan disk I/O VPS.

---
**Note:** Pastikan folder `media/` dan `session/` sudah ada dan memiliki izin tulis (writable).
```bash
mkdir -p media session
chmod 777 media session
```

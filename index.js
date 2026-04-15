const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const { downloadContentFromMessage } = require("@whiskeysockets/baileys")
const os = require("os")

const config = require("./config")
const commandsTemplate = require("./commands.json")
const { ensureDB, loadDB, saveDB } = require("./lib/db")
const {
  cleanText,
  parseMessageText,
  normalizeJidToNumber,
  isOwner,
  runtime
} = require("./lib/utils")
const { getSystemInfo, clearTempFiles } = require("./lib/system")

ensureDB(config.dbFile)

const cooldown = new Map()
const userMsgCount = new Map()

function log(...args) {
  if (config.debug) console.log("[BOT LOG]", ...args)
}

function reply(sock, jid, text, quoted = null, options = {}) {
  return sock.sendMessage(
    jid,
    { text, ...options },
    quoted ? { quoted } : {}
  )
}
async function sendSticker(sock, jid, buffer, quoted, packname = "MyBot", author = "Owner") {
  try {
    const sticker = new Sticker(buffer, {
      pack: packname,
      author: author,
      type: StickerTypes.FULL,
      quality: 70
    })

    const stickerBuffer = await sticker.toBuffer()

    return await sock.sendMessage(jid, {
      sticker: stickerBuffer
    }, { quoted })

  } catch (err) {
    console.error("Sticker convert error:", err)
  }
}

async function downloadMedia(msg) {
  const m = msg.message ? msg.message : msg

  const type = Object.keys(m)[0]

  const stream = await downloadContentFromMessage(
    m[type],
    type.replace("Message", "")
  )

  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }

  return buffer
}

function makeMenu(pushName = "User") {
  const main = (commandsTemplate.main || []).map(x => `│ • ${x}`).join("\n")
  const produk = (commandsTemplate.produk || []).map(x => `│ • ${x}`).join("\n")
  const order = (commandsTemplate.order || []).map(x => `│ • ${x}`).join("\n")
  const owner = (commandsTemplate.owner || []).map(x => `│ • ${x}`).join("\n")
  const group = (commandsTemplate.group || []).map(x => `│ • ${x}`).join("\n")

  return `
┏━━━「 *${config.botName.toUpperCase()}* 」━━━
┃
┃ 👋 Halo, *${pushName}*!
┃ ⌨️ Prefix: \`${config.prefix}\`
┃ 🕒 Time: ${new Date().toLocaleTimeString("id-ID", { timeZone: config.timezone })}
┃
┣━━━「 *MAIN MENU* 」
${main || "┃ • Belum ada"}
┃
┣━━━「 *PRODUCT* 」
${produk || "┃ • Belum ada"}
┃
┣━━━「 *ORDER* 」
${order || "┃ • Belum ada"}
┃
┣━━━「 *GROUP* 」
${group || "┃ • Belum ada"}
┃
┣━━━「 *OWNER* 」
${owner || "┃ • Belum ada"}
┃
┣━━━「 *CARA ORDER* 」
┃ 1. Cek produk: \`-list show\`
┃ 2. Order produk:
┃    \`-order Nama,ID,Qty,Alamat\`
┃    _Contoh: -order Budi,2,1,Jakarta_
┃ 3. Cek status: \`-cekorder ID\`
┃
┗━━━━━━━━━━━━━━━━━━━━
`.trim()
}

function formatProductList(db) {
  if (!db.list.length) return "📭 *List produk kosong*"

  return db.list.map(item => {
    const statusEmoji = item.status === "Ready" ? "✅" : "⛔"
    const stockColor = item.stock > 10 ? "🟢" : item.stock > 0 ? "🟡" : "🔴"
    return `┌─────────────────
│ � *${item.nama}*
│─────────────────
│ 💰 *Rp ${Number(item.harga).toLocaleString("id-ID")}*
│ � Kategori: _${item.kategori}_
│ ${stockColor} Stok: *${item.stock || 0}*
│ ${statusEmoji} Status: *${item.status}*
└─────────────────`
  }).join("\n\n")
}

function createOrderId() {
  return "ORD-" + Date.now()
}

function getQuotedParticipant(m) {
  return m.message?.extendedTextMessage?.contextInfo?.participant || null
}

function updateOrderStatus(db, id, status) {
  const order = db.orders.find(o => o.id === id)
  if (!order) return false

  order.status = status
  order.updatedAt = new Date().toISOString()
  return true
}

setInterval(() => {
  const now = Date.now()
  for (const [key, value] of cooldown.entries()) {
    if (now - value > config.cooldownMs * 3) {
      cooldown.delete(key)
    }
  }
}, config.cooldownSweepMs)

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "120.0.0"],
    markOnlineOnConnect: true,
    syncFullHistory: false
  })

  // Auto Memory & Cache Clear (Optimasi VPS 1GB)
  setInterval(() => {
    const memUsage = process.memoryUsage().rss
    const limit = 512 * 1024 * 1024 // 512MB limit for auto clear
    
    if (memUsage > limit) {
      console.log("⚠️ RAM Usage high, clearing cache...")
      cooldown.clear()
      userMsgCount.clear()
      clearTempFiles()
      if (global.gc) {
        global.gc()
      }
    }
  }, 10 * 60 * 1000) // Every 10 minutes

  // Auto Message (Auto Status) Group - Check every minute
  setInterval(async () => {
    const db = loadDB(config.dbFile)
    const now = Date.now()

    for (const groupId of Object.keys(db.groups)) {
      const g = db.groups[groupId]
      if (g.autoMsg && g.autoMsg.enabled && g.autoMsg.text && g.autoMsg.interval) {
        const lastSent = g.autoMsg.lastSent || 0
        const intervalMs = g.autoMsg.interval * 60 * 1000 // Convert minutes to MS
        
        if (now - lastSent >= intervalMs) {
          try {
            const groupMeta = await sock.groupMetadata(groupId)
            const mentions = groupMeta.participants.map(p => p.id)
            
            await sock.sendMessage(groupId, { 
              text: g.autoMsg.text,
              mentions: mentions 
            })
            
            // Update lastSent
            db.groups[groupId].autoMsg.lastSent = now
            saveDB(config.dbFile, db)
            console.log(`[AUTO MSG] Terkirim ke ${groupId}`)
          } catch (e) {
            console.error(`[AUTO MSG] Gagal ke ${groupId}:`, e.message)
          }
        }
      }
    }
  }, 60 * 1000) // Every 1 minute check

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      console.log("SCAN QR:")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      console.log("✅ BOT ONLINE")
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut

      console.log("❌ CONNECTION CLOSED:", code || "unknown")

      if (shouldReconnect) {
        console.log("🔁 RECONNECT 5 DETIK...")
        setTimeout(startBot, 5000)
      } else {
        console.log("⚠️ SESSION LOGGED OUT, SCAN ULANG QR")
      }
    }
  })

  sock.ev.on("group-participants.update", async (update) => {
    const { id, participants, action } = update
    const db = loadDB(config.dbFile)
    const groupSettings = db.groups[id] || {}

    if (action === "add" && groupSettings.welcome) {
      for (let p of participants) {
        const text = groupSettings.welcomeMsg || `Selamat datang @${p.split("@")[0]} di grup ini!`
        await sock.sendMessage(id, {
          text,
          mentions: [p]
        })
      }
    }

    if (action === "remove" && groupSettings.goodbye) {
      for (let p of participants) {
        const text = groupSettings.goodbyeMsg || `Selamat tinggal @${p.split("@")[0]}!`
        await sock.sendMessage(id, {
          text,
          mentions: [p]
        })
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0]
      if (!m?.message) return
      if (m.key.fromMe) return

      const from = m.key.remoteJid
      const senderJid = m.key.participant || from
      const senderNumber = normalizeJidToNumber(senderJid)
      const pushName = m.pushName || "User"
      const isGroup = from.endsWith("@g.us")

      const rawText = parseMessageText(m.message)
      const text = cleanText(rawText)

      const owner = isOwner(
        senderJid,
        senderNumber,
        config.ownerNumbers,
        config.ownerJids
      )

      let db = loadDB(config.dbFile)

       // User System (XP/Level)
       if (!db.users[senderJid]) {
         db.users[senderJid] = {
           xp: 0,
           level: 1,
           name: pushName,
           orderCount: 0
         }
       }
       const user = db.users[senderJid]
       user.name = pushName
       user.xp += Math.floor(Math.random() * 10) + 5
       const nextLevelXp = user.level * 100
       if (user.xp >= nextLevelXp) {
         user.level++
         user.xp = 0
         await reply(sock, from, `🎉 Selamat @${senderNumber}! Kamu naik ke level ${user.level}`, m)
       }
       saveDB(config.dbFile, db)

       // Group logic (Anti-link, Anti-spam, Mute)
       if (isGroup) {
        const groupSettings = db.groups[from] || {}
        
        // Mute logic
        if (groupSettings.mutedUsers && groupSettings.mutedUsers.includes(senderJid)) {
          const groupMeta = await sock.groupMetadata(from)
          const isAdmin = groupMeta.participants.some(
            p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
          )
          
          if (!isAdmin && !owner) {
            await sock.sendMessage(from, { delete: m.key })
            return
          }
        }

        // Anti-link
        const isLink = /chat\.whatsapp\.com\/|wa\.me\//i.test(text)
        if (groupSettings.antilink && isLink) {
          const groupMeta = await sock.groupMetadata(from)
          const isAdmin = groupMeta.participants.some(
            p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
          )
          
          if (!isAdmin && !owner) {
            await reply(sock, from, "❌ Link terdeteksi, kamu akan dikeluarkan!", m)
            await sock.sendMessage(from, { delete: m.key })
            await sock.groupParticipantsUpdate(from, [senderJid], "remove")
            return
          }
        }

        // Anti-link Global
         if (db.settings.antiLinkGlobal && isLink && !owner) {
            await reply(sock, from, "❌ Link terdeteksi (Global Antilink)!", m)
            await sock.sendMessage(from, { delete: m.key })
            return
         }

         // Anti-spam Group
         if (groupSettings.antispam) {
           const key = `spam-${from}-${senderJid}`
           const now = Date.now()
           const userData = userMsgCount.get(key) || { count: 0, lastMsg: 0 }
           
           if (now - userData.lastMsg < 2000) { // 2 seconds
             userData.count++
           } else {
             userData.count = 1
           }
           userData.lastMsg = now
           userMsgCount.set(key, userData)
           
           if (userData.count > 5) {
              const groupMeta = await sock.groupMetadata(from)
              const isAdmin = groupMeta.participants.some(
                p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
              )
              if (!isAdmin && !owner) {
                await reply(sock, from, "❌ Spam terdeteksi, kamu akan dikeluarkan!", m)
                await sock.groupParticipantsUpdate(from, [senderJid], "remove")
                return
              }
           }
         }
        }
 
        if (!text) return

        let prefix = ""
        const prefixes = db.settings.multiPrefix ? db.settings.prefixes : [config.prefix]
        for (let p of prefixes) {
          if (text.startsWith(p)) {
            prefix = p
            break
          }
        }

        if (!prefix) return

        log("RAW:", rawText)
        log("TEXT:", text)
        log("SENDER:", senderJid)
        log("SENDER NUMBER:", senderNumber)
        log("OWNER NUMBERS:", config.ownerNumbers)
        log("OWNER JIDS:", config.ownerJids)

        const body = text.slice(prefix.length).trim()
        const parts = body.split(/\s+/)
        let cmd = (parts[0] || "").toLowerCase()
        const args = parts.slice(1)

        // Command Alias
        const aliases = {
          "p": "ping",
          "s": "sticker",
          "m": "menu",
          "u": "profile",
          "lb": "leaderboard",
          "bc": "bcuser",
          "bcg": "bcgroup"
        }
        if (aliases[cmd]) cmd = aliases[cmd]

        const now = Date.now()
       if (cooldown.has(senderNumber)) {
         const diff = now - cooldown.get(senderNumber)
         if (diff < config.cooldownMs) return
       }
       cooldown.set(senderNumber, now)

       log("IS OWNER:", owner)

      // Auto delete command logic
      if (isGroup && db.groups[from]?.autodelete) {
        setTimeout(async () => {
          try {
            await sock.sendMessage(from, { delete: m.key })
          } catch (e) {
            console.error("Auto delete error:", e)
          }
        }, 5000)
      }

      if (cmd === "menu") {
        return reply(sock, from, makeMenu(pushName), m)
      }

      if (cmd === "ping") {
        return reply(sock, from, "🏓 Pong", m)
      }

      if (cmd === "runtime") {
        return reply(sock, from, `⏱ Runtime bot: ${runtime(process.uptime())}`, m)
      }

      if (cmd === "owner") {
        return reply(sock, from, `👑 Owner: wa.me/${config.ownerNumbers[0]}`, m)
      }

      if (cmd === "stats") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const info = getSystemInfo()

        return reply(
          sock,
          from,
          `
📊 *DETAIL SERVER STATS*

🌐 *HOST INFO*
• Host: ${info.hostname}
• OS: ${info.platform}
• Arch: ${info.arch}
• Node: ${info.nodeVersion}

🧠 *CPU & LOAD*
• Model: ${info.cpuModel}
• Core: ${info.cpuCores}
• Load Avg: ${info.loadAvg}

📦 *RAM USAGE*
• Total: ${info.totalMem}
• Used: ${info.usedMem}
• Free: ${info.freeMem}
• Usage: ${info.memUsagePercent}

⚙️ *PROCESS MEMORY*
• RSS: ${info.processRss}
• Heap Used: ${info.processHeapUsed}
• Heap Total: ${info.processHeapTotal}

⏱ *UPTIME*
• System: ${info.uptime}
`.trim(),
          m
        )
      }

      // User System Commands
      if (cmd === "profile" || cmd === "me") {
        const target = getQuotedParticipant(m) || senderJid
        const userData = db.users[target]

        if (!userData) return reply(sock, from, "❌ User belum terdaftar di database", m)

        const myOrders = db.orders.filter(o => String(o.user) === String(target.split("@")[0]))

        return reply(
          sock,
          from,
          `
👤 *USER PROFILE*

👤 Nama: ${userData.name}
🔢 Nomor: @${target.split("@")[0]}
🌟 Level: ${userData.level}
✨ XP: ${userData.xp} / ${userData.level * 100}
📦 Total Order: ${myOrders.length}
👑 Status: ${isOwner(target, target.split("@")[0], config.ownerNumbers, config.ownerJids) ? "Owner" : "User"}
`.trim(),
          m
        )
      }

      if (cmd === "leaderboard" || cmd === "lb") {
        const sorted = Object.entries(db.users)
          .sort(([, a], [, b]) => {
            if (a.level !== b.level) return b.level - a.level
            return b.xp - a.xp
          })
          .slice(0, 10)

        let teks = "🏆 *LEADERBOARD TOP 10*\n\n"
        sorted.forEach(([jid, data], i) => {
          teks += `${i + 1}. ${data.name} (@${jid.split("@")[0]})\n`
          teks += `   Level: ${data.level} | XP: ${data.xp}\n`
        })

        return reply(sock, from, teks.trim(), m)
      }

      if (cmd === "clearcache") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        cooldown.clear()
        userMsgCount.clear()
        const removed = clearTempFiles()

        if (global.gc) {
          global.gc()
        }

        return reply(
          sock,
          from,
          `
🧹 Cache dibersihkan

• Cooldown: reset
• Spam Count: reset
• Temp folder: ${removed.length ? removed.join(", ") : "tidak ada"}
• Manual GC: ${global.gc ? "aktif" : "tidak aktif"}
`.trim(),
          m
        )
      }

      // System Settings
      if (cmd === "settings") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const sub = (args[0] || "").toLowerCase()
        if (sub === "antilinkglobal") {
          db.settings.antiLinkGlobal = !db.settings.antiLinkGlobal
          saveDB(config.dbFile, db)
          return reply(sock, from, `✅ Anti Link Global: ${db.settings.antiLinkGlobal ? "ON" : "OFF"}`, m)
        }
        if (sub === "multiprefix") {
          db.settings.multiPrefix = !db.settings.multiPrefix
          saveDB(config.dbFile, db)
          return reply(sock, from, `✅ Multi Prefix: ${db.settings.multiPrefix ? "ON" : "OFF"}`, m)
        }
        return reply(sock, from, "Gunakan:\n-settings antilinkglobal\n-settings multiprefix", m)
      }

      if (cmd === "backup") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const buffer = fs.readFileSync(config.dbFile)
        await sock.sendMessage(from, {
          document: buffer,
          mimetype: "application/json",
          fileName: "db_backup.json"
        }, { quoted: m })
        return reply(sock, from, "✅ Database backup terkirim", m)
      }

      if (cmd === "groupanalytics" || cmd === "ganalytics") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const totalMembers = groupMeta.participants.length
        const admins = groupMeta.participants.filter(p => p.admin).length
        
        return reply(
          sock,
          from,
          `
📊 *GROUP ANALYTICS*

👥 Total Member: ${totalMembers}
👮‍♂️ Total Admin: ${admins}
📅 Dibuat: ${new Date(groupMeta.creation * 1000).toLocaleString()}
📝 Deskripsi: ${groupMeta.desc || "-"}
`.trim(),
          m
        )
      }

      if (cmd === "restart") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await reply(sock, from, "🔄 Bot akan restart...", m)

        setTimeout(() => {
          process.exit(1)
        }, 1500)

        return
      }

      // Broadcast Commands
      if (cmd === "bcuser" || cmd === "bcgrup" || cmd === "bcgroup" || cmd === "bcpromo") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const textOut = args.join(" ")
        if (!textOut) return reply(sock, from, "❌ Masukkan teks", m)

        let targets = []
        if (cmd === "bcuser") {
          targets = Object.keys(db.users)
        } else {
          const groups = await sock.groupFetchAllParticipating()
          targets = Object.keys(groups)
        }

        const isPromo = cmd === "bcpromo"
        const header = isPromo ? "📢 *PROMO SPESIAL*\n\n" : "📢 *BROADCAST*\n\n"
        const footer = isPromo ? "\n\n🔥 *BURUAN ORDER SEBELUM KEHABISAN!*" : ""

        await reply(sock, from, `🚀 Mengirim broadcast ke ${targets.length} target...`, m)

        for (let t of targets) {
          try {
            await sock.sendMessage(t, { text: header + textOut + footer })
            await new Promise(res => setTimeout(res, 8000))
          } catch (e) {
            console.error(`Gagal kirim ke ${t}:`, e)
          }
        }
        return reply(sock, from, "✅ Broadcast selesai", m)
      }

      if (cmd === "list") {
        const sub = (args[0] || "").toLowerCase()

        if (sub === "show") {
          const textOut = formatProductList(db)
          return reply(sock, from, `🛒 *DAFTAR PRODUK*\n\n${textOut}\n\n_Order: -order Nama,ID,Qty,Alamat_`, m)
        }

        if (sub === "search") {
          const query = args.slice(1).join(" ").trim().toLowerCase()
          if (!query) return reply(sock, from, "❌ Masukkan kata kunci pencarian", m)

          const hasil = db.list.filter(item =>
            item.nama.toLowerCase().includes(query) ||
            item.kategori.toLowerCase().includes(query)
          )

          if (!hasil.length) return reply(sock, from, "❌ Produk tidak ditemukan", m)

          const textOut = hasil.map(item =>
            `${item.id}. ${item.nama} - ${item.harga} (Stok: ${item.stock || 0})`
          ).join("\n")

          return reply(sock, from, `🔍 HASIL PENCARIAN "${query.toUpperCase()}"\n\n${textOut}`, m)
        }

        if (sub === "kategori") {
          const kategori = args.slice(1).join(" ").trim().toLowerCase()

          if (!kategori) {
            return reply(sock, from, "❌ Contoh: -list kategori AI", m)
          }

          const hasil = db.list.filter(item =>
            String(item.kategori).toLowerCase() === kategori
          )

          if (!hasil.length) {
            return reply(sock, from, "❌ Produk kategori itu tidak ditemukan", m)
          }

          const textOut = hasil.map(item =>
            `${item.id}. ${item.nama} - ${item.harga} (Stok: ${item.stock || 0})`
          ).join("\n")

          return reply(sock, from, `📂 KATEGORI ${kategori.toUpperCase()}\n\n${textOut}`, m)
        }

        if (sub === "add") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const raw = args.slice(1).join(" ")
          const data = raw.split("|")

          if (data.length < 5) {
            return reply(sock, from, "❌ Format: -list add Nama|Harga|Kategori|Status|Stock", m)
          }

          const [nama, hargaRaw, kategori, status, stockRaw] = data.map(x => x.trim())
          const harga = Number(hargaRaw)
          const stock = Number(stockRaw)

          if (!nama || Number.isNaN(harga) || !kategori || !status || Number.isNaN(stock)) {
            return reply(sock, from, "❌ Data produk tidak valid", m)
          }

          // Duplicate protection
          const exists = db.list.some(item => item.nama.toLowerCase() === nama.toLowerCase())
          if (exists) return reply(sock, from, `❌ Produk dengan nama "${nama}" sudah ada`, m)

          const newId = db.list.length
            ? Math.max(...db.list.map(x => Number(x.id) || 0)) + 1
            : 1

          db.list.push({
            id: newId,
            nama,
            harga,
            kategori,
            status,
            stock
          })

          saveDB(config.dbFile, db)

          return reply(
            sock,
            from,
            `✅ Produk ditambahkan

🆔 ${newId}
📦 ${nama}
💰 ${harga}
🗂 ${kategori}
📌 ${status}
📦 Stok: ${stock}`,
            m
          )
        }

        if (sub === "edit") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const id = Number(args[1])
          const raw = args.slice(2).join(" ")
          const [key, value] = raw.split("=").map(x => x.trim())

          if (Number.isNaN(id) || !key || !value) {
            return reply(sock, from, "❌ Format: -list edit ID key=value\nContoh: -list edit 1 stock=10", m)
          }

          const index = db.list.findIndex(item => Number(item.id) === id)
          if (index === -1) return reply(sock, from, "❌ Produk tidak ditemukan", m)

          const validKeys = ["nama", "harga", "kategori", "status", "stock"]
          if (!validKeys.includes(key.toLowerCase())) {
            return reply(sock, from, `❌ Key tidak valid. Gunakan: ${validKeys.join(", ")}`, m)
          }

          let finalValue = value
          if (key === "harga" || key === "stock") finalValue = Number(value)
          if ((key === "harga" || key === "stock") && Number.isNaN(finalValue)) {
            return reply(sock, from, `❌ ${key} harus angka`, m)
          }

          db.list[index][key] = finalValue
          saveDB(config.dbFile, db)

          return reply(sock, from, `✅ Produk ${id} diperbarui: ${key} = ${finalValue}`, m)
        }

        if (sub === "remove") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const id = Number(args[1])

          if (Number.isNaN(id)) {
            return reply(sock, from, "❌ Format: -list remove ID", m)
          }

          const before = db.list.length
          db.list = db.list.filter(item => Number(item.id) !== id)

          if (db.list.length === before) {
            return reply(sock, from, "❌ Produk tidak ditemukan", m)
          }

          saveDB(config.dbFile, db)
          return reply(sock, from, `🗑 Produk dengan ID ${id} dihapus`, m)
        }

        return reply(
          sock,
          from,
          "Gunakan:\n-list show\n-list search Nama\n-list kategori AI\n-list add Nama|Harga|Kategori|Status|Stock\n-list edit ID key=value\n-list remove ID",
          m
        )
      }

      if (cmd === "order") {
        const raw = args.join(" ")
        const data = raw.split(",")

        if (data.length < 4) {
          return reply(
            sock,
            from,
            "❌ Format: -order nama,idproduk,qty,alamat\nContoh: -order Bagas,2,1,-",
            m
          )
        }

        const [nama, produkIdRaw, qtyRaw, alamat] = data.map(x => x.trim())
        const produkId = Number(produkIdRaw)
        const qty = Number(qtyRaw)

        if (!nama || Number.isNaN(produkId) || Number.isNaN(qty)) {
          return reply(sock, from, "❌ ID produk dan qty harus angka", m)
        }

        const productIndex = db.list.findIndex(item => Number(item.id) === produkId)
        if (productIndex === -1) {
          return reply(sock, from, "❌ Produk tidak ditemukan. Ketik -list show", m)
        }
        
        const product = db.list[productIndex]

        // Check stock
        if (product.stock < qty) {
          return reply(sock, from, `❌ Stok tidak cukup. Stok saat ini: ${product.stock}`, m)
        }

        const id = createOrderId()
        const isoNow = new Date().toISOString()
        const totalPrice = product.harga * qty

        db.orders.push({
          id,
          nama,
          produk: product.nama,
          harga: product.harga,
          total: totalPrice,
          qty,
          alamat,
          user: senderNumber,
          status: "pending",
          notes: "",
          createdAt: isoNow,
          updatedAt: isoNow
        })

        // Decrease stock
        db.list[productIndex].stock -= qty

        saveDB(config.dbFile, db)

        return reply(
          sock,
          from,
          `
🧾 *INVOICE OTOMATIS*

🆔 ID: ${id}
👤 Nama: ${nama}
📦 Produk: ${product.nama}
💰 Harga Satuan: ${product.harga}
🔢 Qty: ${qty}
💵 Total: ${totalPrice}
📍 Alamat: ${alamat}
📌 Status: pending
🕒 Tanggal: ${isoNow.split("T")[0]}

Ketik *-cekorder ${id}* untuk melihat status.
`.trim(),
          m
        )
      }

      if (cmd === "cancelorder") {
        const id = args[0]
        if (!id) return reply(sock, from, "❌ Masukkan ID order", m)

        const orderIndex = db.orders.findIndex(o => o.id === id)
        if (orderIndex === -1) return reply(sock, from, "❌ Order tidak ditemukan", m)
        
        const order = db.orders[orderIndex]
        
        // Only owner or the user who ordered can cancel
        if (String(order.user) !== String(senderNumber) && !owner) {
          return reply(sock, from, "❌ Kamu tidak bisa membatalkan order ini", m)
        }

        if (order.status !== "pending") {
          return reply(sock, from, `❌ Order tidak bisa dibatalkan karena status: ${order.status}`, m)
        }

        db.orders[orderIndex].status = "cancelled"
        db.orders[orderIndex].updatedAt = new Date().toISOString()
        
        // Restore stock
        const productIndex = db.list.findIndex(p => p.nama === order.produk)
        if (productIndex !== -1) {
          db.list[productIndex].stock += order.qty
        }

        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Order ${id} berhasil dibatalkan dan stok dikembalikan`, m)
      }

      if (cmd === "addnote") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        
        const id = args[0]
        const note = args.slice(1).join(" ")
        
        if (!id || !note) return reply(sock, from, "❌ Format: -addnote ID Catatan", m)
        
        const orderIndex = db.orders.findIndex(o => o.id === id)
        if (orderIndex === -1) return reply(sock, from, "❌ Order tidak ditemukan", m)
        
        db.orders[orderIndex].notes = note
        db.orders[orderIndex].updatedAt = new Date().toISOString()
        
        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Catatan ditambahkan ke order ${id}`, m)
      }

      if (cmd === "process") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const id = args[0]
        if (!id) return reply(sock, from, "❌ Masukkan ID order", m)

        const ok = updateOrderStatus(db, id, "process")
        if (!ok) return reply(sock, from, "❌ Order tidak ditemukan", m)

        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Status order ${id} diubah ke PROCESS`, m)
      }

      if (cmd === "myorder") {
        const myOrders = db.orders.filter(o => String(o.user) === String(senderNumber))

        if (!myOrders.length) {
          return reply(sock, from, "📭 Kamu belum punya order", m)
        }

        const textOut = myOrders.map((o, i) => {
          return `${i + 1}. ${o.id}
📦 ${o.produk}
🔢 Qty: ${o.qty}
📌 Status: ${o.status}
🕒 ${o.createdAt}`
        }).join("\n\n")

        return reply(sock, from, `📦 ORDER KAMU\n\n${textOut}`, m)
      }

      if (cmd === "cekorder") {
        const id = args[0]

        if (!id) {
          return reply(sock, from, "❌ Masukkan ID order", m)
        }

        const order = db.orders.find(o => o.id === id)

        if (!order) {
          return reply(sock, from, "❌ Order tidak ditemukan", m)
        }

        return reply(
          sock,
          from,
          `
📦 DETAIL ORDER

🆔 ${order.id}
👤 ${order.nama}
📦 ${order.produk}
🔢 Qty: ${order.qty}
📍 ${order.alamat}
📌 ${order.status}
📝 Note: ${order.notes || "-"}
🕒 Dibuat: ${order.createdAt}
🕒 Diupdate: ${order.updatedAt}
`.trim(),
          m
        )
      }

      if (cmd === "done" || cmd === "fail" || cmd === "refund") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const id = args[0]

        if (!id) {
          return reply(sock, from, "❌ Masukkan ID order", m)
        }

        const statusMap = {
          done: "success",
          fail: "failed",
          refund: "refund"
        }

        const ok = updateOrderStatus(db, id, statusMap[cmd])

        if (!ok) {
          return reply(sock, from, "❌ Order tidak ditemukan", m)
        }

        // If refund, restore stock
        if (cmd === "refund") {
          const order = db.orders.find(o => o.id === id)
          const productIndex = db.list.findIndex(p => p.nama === order.produk)
          if (productIndex !== -1) {
            db.list[productIndex].stock += order.qty
          }
        }

        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Status order ${id} diubah ke ${statusMap[cmd]}`, m)
      }

      if (cmd === "kick") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const target = getQuotedParticipant(m)
        if (!target) return reply(sock, from, "❌ Reply pesan target dulu", m)

        await sock.groupParticipantsUpdate(from, [target], "remove")
        return reply(sock, from, "✅ User berhasil dikeluarkan", m)
      }

      if (cmd === "close") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await sock.groupSettingUpdate(from, "announcement")
        return reply(sock, from, "🔒 Grup ditutup (Hanya admin yang bisa kirim pesan)", m)
      }

      if (cmd === "open") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await sock.groupSettingUpdate(from, "not_announcement")
        return reply(sock, from, "� Grup dibuka (Semua bisa kirim pesan)", m)
      }

      if (cmd === "mute") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedParticipant(m)
        if (!target) return reply(sock, from, "❌ Tag atau reply orang yang mau di-mute", m)

        if (!db.groups[from]) db.groups[from] = {}
        if (!db.groups[from].mutedUsers) db.groups[from].mutedUsers = []
        
        if (db.groups[from].mutedUsers.includes(target)) {
           return reply(sock, from, "❌ User sudah di-mute", m)
        }

        db.groups[from].mutedUsers.push(target)
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Berhasil mute @${target.split("@")[0]}. Setiap pesan dia bakal langsung dihapus!`, m, { mentions: [target] })
      }

      if (cmd === "unmute") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || getQuotedParticipant(m)
        if (!target) return reply(sock, from, "❌ Tag atau reply orang yang mau di-unmute", m)

        if (!db.groups[from] || !db.groups[from].mutedUsers) {
           return reply(sock, from, "❌ Belum ada user yang di-mute di grup ini", m)
        }

        const index = db.groups[from].mutedUsers.indexOf(target)
        if (index === -1) {
           return reply(sock, from, "❌ User tidak ada di daftar mute", m)
        }

        db.groups[from].mutedUsers.splice(index, 1)
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Berhasil unmute @${target.split("@")[0]}`, m, { mentions: [target] })
      }

      if (cmd === "produk") {
        const textOut = formatProductList(db)
        return reply(sock, from, `🛒 *DAFTAR PRODUK*\n\n${textOut}\n\n_Order: -order Nama,ID,Qty,Alamat_`, m)
      }
    
      if (cmd === "sticker" || cmd === "s") {
        try {
          let quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
          let msg = null

          if (quoted) {
            msg = { message: quoted }
          } else if (m.message?.imageMessage) {
            msg = m
          }

          if (!msg) {
            return reply(sock, from, "❌ Kirim/reply gambar", m)
          }

          const buffer = await downloadMedia(msg)

          await sendSticker(sock, from, buffer, m)

        } catch (err) {
          console.error("Sticker error:", err)
          return reply(sock, from, "❌ Gagal buat sticker", m)
        }
      }


      if (cmd === "spam") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)

        const groupMeta = await sock.groupMetadata(from)

        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )

        if (!isAdmin) return reply(sock, from, "❌ Khusus admin", m)

        if (args.length < 3) {
          return reply(sock, from,
            "❌ Format:\n-spam teks jumlah delay(ms)\natau\n-spam 628xxxx teks jumlah delay",
            m
          )
        }

        let target = from
        let textSpam = ""
        let jumlah, delay

        // kirim ke nomor lain
        if (args[0].startsWith("62")) {
          target = args[0] + "@s.whatsapp.net"
          textSpam = args.slice(1, -2).join(" ")
          jumlah = Number(args[args.length - 2])
          delay = Number(args[args.length - 1])

          // 🔥 proteksi: hanya owner boleh spam luar
          if (!owner) {
            return reply(sock, from, "❌ Spam ke nomor luar hanya owner", m)
          }

        } else {
          textSpam = args.slice(0, -2).join(" ")
          jumlah = Number(args[args.length - 2])
          delay = Number(args[args.length - 1])
        }

        if (!textSpam || isNaN(jumlah) || isNaN(delay)) {
          return reply(sock, from, "❌ Format salah", m)
        }

        // 🔥 limit biar aman
        if (jumlah > 10) return reply(sock, from, "❌ Max 10 spam", m)
        if (delay < 2000) return reply(sock, from, "❌ Delay minimal 2000ms", m)

        await reply(sock, from, "✅ Spam dimulai...", m)

        for (let i = 0; i < jumlah; i++) {
          await sock.sendMessage(target, { text: textSpam })
          await new Promise(res => setTimeout(res, delay))
        }

        await reply(sock, from, "✅ Spam selesai", m)
      }

      if (cmd === "tagall") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)

        const groupMeta = await sock.groupMetadata(from)

        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )

        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const participants = groupMeta.participants

        const textCustom = args.join(" ") || "📢 TAG ALL"

        let teks = textCustom + "\n\n"
        let mentions = []

        for (let p of participants) {
          mentions.push(p.id)
          teks += `• @${p.id.split("@")[0]}\n`
        }

        return await sock.sendMessage(from, {
          text: teks,
          mentions
        }, { quoted: m })
      }

      if (cmd === "hidetagall" || cmd === "hta") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const groupMeta = await sock.groupMetadata(from)
        const participants = groupMeta.participants
        
        const textCustom = args.join(" ")
        if (!textCustom) return reply(sock, from, "❌ Masukkan teks promosi\nContoh: -hta Promo Netflix Murah!", m)

        let mentions = participants.map(p => p.id)

        return await sock.sendMessage(from, {
          text: textCustom,
          mentions
        })
      }

      if (cmd === "guide") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        
        const textGuide = `
📖 *OWNER GUIDE - CONTOH PERINTAH & OUTPUT*

1️⃣ *MANAJEMEN PRODUK*
• *Tambah*: \`-list add Netflix|35000|Streaming|Ready|50\`
  └ _Output: Kartu produk baru dengan stok 50._
• *Edit*: \`-list edit 1 stock=100\`
  └ _Output: "✅ Produk 1 diperbarui: stock = 100"_

2️⃣ *MANAJEMEN ORDER*
• *Proses*: \`-process ORD-123\`
  └ _Output: "✅ Status order ORD-123 diubah ke PROCESS"_
• *Selesai*: \`-done ORD-123\`
  └ _Output: "✅ Status order ORD-123 diubah ke success"_
• *Catatan*: \`-addnote ORD-123 Akun: abc@mail.com | Pass: 123\`

3️⃣ *AUTO MESSAGE (AUTO STATUS GRUP)*
• *Set*: \`-setautomsg Promo Netflix|60\` (Teks|Menit)
• *On/Off*: \`-automsg on\` atau \`-automsg off\`
• *Remove*: \`-removeautomsg\`

4️⃣ *PROMOSI & BROADCAST*
• *Hide Tag*: \`-hta Promo Netflix!\`
  └ _Output: Pesan terkirim ke grup tanpa daftar tag, tapi semua kena notif._
• *BC Promo*: \`-bcpromo Promo Spesial!\`
  └ _Output: Kirim ke semua grup dengan delay 8 detik._

5️⃣ *KEAMANAN & SISTEM*
• *Mute*: \`-mute @tag\`
• *Stats*: \`-stats\` (Monitor VPS RAM 1GB)
• *Backup*: \`-backup\` (Bot kirim file db.json)
`.trim()

        return reply(sock, from, textGuide, m)
      }

      // Auto Message (Auto Status) Commands
      if (cmd === "setautomsg" || cmd === "editautomsg") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const raw = args.join(" ")
        const [textMsg, intervalRaw] = raw.split("|").map(x => x.trim())
        const interval = Number(intervalRaw)

        if (!textMsg || isNaN(interval) || interval < 1) {
          return reply(sock, from, `❌ Format: -${cmd} Teks|IntervalMenit\nContoh: -${cmd} Promo Netflix Murah|60`, m)
        }

        if (!db.groups[from]) db.groups[from] = {}
        db.groups[from].autoMsg = {
          enabled: db.groups[from].autoMsg?.enabled || false,
          text: textMsg,
          interval: interval,
          lastSent: 0
        }
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Auto Message berhasil diatur!\n\n📝 Teks: ${textMsg}\n⏱ Interval: ${interval} menit\n📌 Status: ${db.groups[from].autoMsg.enabled ? "ON" : "OFF"}\n\nKetik *-automsg on* untuk mengaktifkan.`, m)
      }

      if (cmd === "automsg") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, "Gunakan: -automsg on/off", m)

        if (!db.groups[from]?.autoMsg?.text) {
          return reply(sock, from, "❌ Atur teks dulu dengan: -setautomsg Teks|Menit", m)
        }

        db.groups[from].autoMsg.enabled = (sub === "on")
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Auto Message diubah ke ${sub.toUpperCase()}`, m)
      }

      if (cmd === "removeautomsg") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        if (!db.groups[from]?.autoMsg) return reply(sock, from, "❌ Tidak ada setting Auto Message di grup ini", m)

        delete db.groups[from].autoMsg
        saveDB(config.dbFile, db)

        return reply(sock, from, "✅ Setting Auto Message berhasil dihapus", m)
      }

      if (cmd === "tagadmin") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const admins = groupMeta.participants.filter(p => p.admin)
        
        let teks = "👮‍♂️ *PANGGILAN ADMIN*\n\n"
        let mentions = []
        for (let a of admins) {
          mentions.push(a.id)
          teks += `@${a.id.split("@")[0]}\n`
        }
        return await sock.sendMessage(from, { text: teks, mentions })
      }

      if (cmd === "kickall") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        
        const groupMeta = await sock.groupMetadata(from)
        const nonAdmins = groupMeta.participants.filter(p => !p.admin)
        
        await reply(sock, from, `🚀 Mengeluarkan ${nonAdmins.length} member non-admin...`, m)
        
        for (let p of nonAdmins) {
          try {
            await sock.groupParticipantsUpdate(from, [p.id], "remove")
            await new Promise(res => setTimeout(res, 500))
          } catch (e) {
            console.error(`Gagal kick ${p.id}:`, e)
          }
        }
        return reply(sock, from, "✅ Selesai", m)
      }

      // Security Grup Commands
      if (["antilink", "welcome", "goodbye", "autodelete"].includes(cmd)) {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, `Gunakan: -${cmd} on/off`, m)

        if (!db.groups[from]) db.groups[from] = {}
        db.groups[from][cmd] = (sub === "on")
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ ${cmd.toUpperCase()} diubah ke ${sub.toUpperCase()}`, m)
      }

      if (cmd === "setwelcome" || cmd === "setgoodbye") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const textOut = args.join(" ")
         if (!textOut) return reply(sock, from, `Gunakan: -${cmd} teks`, m)

        if (!db.groups[from]) db.groups[from] = {}
        const key = cmd === "setwelcome" ? "welcomeMsg" : "goodbyeMsg"
        db.groups[from][key] = textOut
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Teks ${cmd.replace("set", "")} berhasil diatur`, m)
      }

      if (cmd === "lock") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub === "on") {
          await sock.groupSettingUpdate(from, "locked")
          return reply(sock, from, "✅ Grup terkunci (hanya admin bisa edit info)", m)
        } else if (sub === "off") {
          await sock.groupSettingUpdate(from, "unlocked")
          return reply(sock, from, "✅ Grup terbuka (semua bisa edit info)", m)
        } else {
          return reply(sock, from, "Gunakan: -lock on/off", m)
        }
      }

      return reply(sock, from, "❓ Command tidak dikenal. Ketik -menu", m)
    } catch (err) {
      console.error("ERROR messages.upsert:", err)
    }
  })
}

startBot().catch(console.error)
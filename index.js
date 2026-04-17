const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")
const { Jimp } = require("jimp")
const ImageScript = require("imagescript")
const fs = require("fs")
const path = require("path")
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

// Global kick cooldown tracking
const kickCooldowns = new Map()

async function safeKick(sock, groupId, participantJid) {
  const now = Date.now()
  const lastKick = kickCooldowns.get(groupId) || 0
  const waitTime = 5000 // 5 seconds between kicks in the same group
  
  const elapsed = now - lastKick
  if (elapsed < waitTime) {
    await new Promise(res => setTimeout(res, waitTime - elapsed))
  }
  
  try {
    await sock.groupParticipantsUpdate(groupId, [participantJid], "remove")
    kickCooldowns.set(groupId, Date.now())
  } catch (e) {
    console.error(`[SAFE KICK ERROR] Gagal kick ${participantJid} di ${groupId}:`, e.message)
  }
}

function log(...args) {
  if (config.debug) console.log("[BOT LOG]", ...args)
}

function reply(sock, jid, text, quoted = null, options = {}) {
  // Safety check for jid to avoid TypeError
  if (typeof jid !== "string") {
    console.error("[REPLY ERROR] Invalid JID type:", typeof jid, jid)
    return
  }

  // Safety check for text argument to avoid TypeError [ERR_INVALID_ARG_TYPE]
  let textContent = ""
  if (typeof text === "string") {
    textContent = text
  } else if (text && typeof text === "object") {
    try {
      textContent = JSON.stringify(text)
    } catch (e) {
      textContent = String(text)
    }
  } else {
    textContent = String(text || "")
  }
  
  // Ensure mentions is an array of strings
  const sendOptions = { ...options }
  if (sendOptions.mentions && !Array.isArray(sendOptions.mentions)) {
    sendOptions.mentions = [sendOptions.mentions]
  }
  if (sendOptions.mentions) {
    sendOptions.mentions = sendOptions.mentions.filter(m => typeof m === "string")
  }

  // Safety check for quoted message
  const quotedMsg = (quoted && quoted.key && typeof quoted.key === "object") ? { quoted } : {}

  return sock.sendMessage(
    jid,
    { text: textContent, ...sendOptions },
    quotedMsg
  ).catch(err => {
    console.error("[SEND MESSAGE ERROR]:", err)
  })
}
async function sendSticker(sock, jid, buffer, quoted, packname = "MyBot", author = "Owner") {
  try {
    // Pastikan buffer adalah Buffer yang valid
    if (!Buffer.isBuffer(buffer)) {
      console.error("[STICKER ERROR] Input bukan buffer!")
      return
    }

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

function makeFitur(pushName = "User") {
  let menuText = `
┏━━━「 *${config.botName.toUpperCase()}* 」━━━
┃
┃ 👋 Halo, *${pushName}*!
┃ 🕒 Time: ${new Date().toLocaleTimeString("id-ID", { timeZone: config.timezone })}
┃`

  for (const category in commandsTemplate) {
    const categoryName = category.toUpperCase()
    const commands = commandsTemplate[category]
    
    menuText += `\n┣━━━「 *${categoryName}* 」\n`
    menuText += commands.map(cmd => `┃ • ${cmd}`).join("\n")
    menuText += "\n┃"
  }

  menuText += `
┣━━━「 *INFO* 」
┃ • Gunakan tanpa tanda baca
┃   untuk fitur umum (User).
┃ • Gunakan tanda pagar (#)
┃   untuk fitur admin (Owner).
┃
┣━━━「 *CARA ORDER* 」
┃ 1. Cek produk: \`list\`
┃ 2. Order produk:
┃    \`order Nama,ID,Qty,Alamat\`
┃    _Contoh: order Budi,2,1,Jakarta_
┃ 3. Cek status: \`cekorder ID\`
┃
┗━━━━━━━━━━━━━━━━━━━━`

  return menuText.trim()
}

function formatProductList(db) {
  if (!db.list.length) return "📭 *List produk kosong*"

  return db.list.map(item => {
    const statusEmoji = item.status === "Ready" ? "✅" : "⛔"
    const stockColor = item.stock > 10 ? "🟢" : item.stock > 0 ? "🟡" : "🔴"
    const promoTag = item.isPromo ? "🔥 *PROMO* 🔥\n" : ""
    const description = item.deskripsi ? `\n📝 _${item.deskripsi}_` : ""
    
    return `╭━━━━━━━━━━━━━━━━━╮
┃   📦 *${item.nama.toUpperCase()}*   ┃
┣━━━━━━━━━━━━━━━━━┫
┃ 🆔 ID: \`${item.id}\`
┃ 💰 Harga: *Rp ${Number(item.harga).toLocaleString("id-ID")}*
┃ 🗂 Kategori: _${item.kategori}_
┃ ${stockColor} Stok: *${item.stock || 0}*
┃ ${statusEmoji} Status: *${item.status}*
┃ ${promoTag}${description}
╰━━━━━━━━━━━━━━━━━╯`.trim()
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

  // Auto Status (Story) - Check every minute
   setInterval(async () => {
     const db = loadDB(config.dbFile)
     const now = Date.now()
     const s = db.settings?.autoStatus || {}
 
     if (s.enabled && s.text && s.interval) {
       const lastSent = s.lastSent || 0
       const intervalMs = s.interval * 60 * 1000
       
       if (now - lastSent >= intervalMs) {
         try {
           // Ambil semua member dari grup-grup bot untuk dikirimi status
           const groups = await sock.groupFetchAllParticipating()
           const participants = new Set()
           
           for (const g of Object.values(groups)) {
             for (const p of g.participants) {
               participants.add(p.id)
             }
           }
 
           await sock.sendMessage("status@broadcast", { 
             text: s.text 
           }, { 
             statusJidList: Array.from(participants) 
           })
           
           // Update lastSent
           db.settings.autoStatus.lastSent = now
           saveDB(config.dbFile, db)
           console.log(`[AUTO STATUS] Terkirim ke ${participants.size} kontak (WhatsApp Status)`)
         } catch (e) {
           console.error(`[AUTO STATUS] Gagal:`, e.message)
         }
       }
     }
  }, 60 * 1000)

  // Auto Status Per Group (Story specifically for group members)
  setInterval(async () => {
    const db = loadDB(config.dbFile)
    const now = Date.now()

    for (const groupId of Object.keys(db.groups)) {
      const g = db.groups[groupId]
      if (g.groupStatus && g.groupStatus.enabled && g.groupStatus.text && g.groupStatus.interval) {
        const lastSent = g.groupStatus.lastSent || 0
        const intervalMs = g.groupStatus.interval * 60 * 1000
        
        if (now - lastSent >= intervalMs) {
          try {
            const groupMeta = await sock.groupMetadata(groupId)
            const participants = groupMeta.participants.map(p => p.id)
            
            await sock.sendMessage("status@broadcast", { 
              text: g.groupStatus.text 
            }, { 
              statusJidList: participants 
            })
            
            // Update lastSent
            db.groups[groupId].groupStatus.lastSent = now
            saveDB(config.dbFile, db)
            console.log(`[GROUP STATUS] Terkirim ke member grup ${groupId}`)
          } catch (e) {
            console.error(`[GROUP STATUS] Gagal ke ${groupId}:`, e.message)
          }
        }
      }
    }
  }, 60 * 1000)

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

  // Anti-Call Protection
  sock.ev.on("call", async (call) => {
    const { from, id, status } = call[0]
    if (status === "offer") {
      console.log(`[ANTI-CALL] Memblokir panggilan dari ${from}`)
      await sock.rejectCall(id, from)
      await sock.sendMessage(from, { text: "⚠️ *ANTI-CALL*\nMaaf, bot tidak menerima panggilan telepon/video. Akun Anda telah diblokir otomatis demi keamanan bot." })
      await sock.updateBlockStatus(from, "block")
    }
  })

  sock.ev.on("group-participants.update", async (update) => {
    const { id, participants, action } = update
    
    // Safety check: ensure participants are strings (JIDs)
    const jids = participants.map(p => typeof p === "string" ? p : (p.id || p.jid || String(p)))
    
    console.log(`[GROUP EVENT] ${action} in ${id} for ${jids.join(", ")}`)
    
    const db = loadDB(config.dbFile)
    const groupSettings = db.groups[id] || {}
    
    if (action === "add" && groupSettings.welcome) {
      for (let p of jids) {
        let text = groupSettings.welcomeMsg || `Selamat datang @${p.split("@")[0]} di grup ini!`
        // Replace @user placeholder if exists
        text = text.replace(/@user/g, `@${p.split("@")[0]}`)
        
        console.log(`[SENDING WELCOME] to ${p}`)
        await reply(sock, id, text, null, { mentions: [p] })
      }
    }

    if (action === "remove" && groupSettings.goodbye) {
      for (let p of jids) {
        let text = groupSettings.goodbyeMsg || `Selamat tinggal @${p.split("@")[0]}!`
        // Replace @user placeholder if exists
        text = text.replace(/@user/g, `@${p.split("@")[0]}`)
        
        console.log(`[SENDING GOODBYE] to ${p}`)
        await reply(sock, id, text, null, { mentions: [p] })
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0]
      if (!m?.message) return

      const from = m.key.remoteJid
      const senderJid = m.key.participant || from
      const senderNumber = normalizeJidToNumber(senderJid)
      const pushName = m.pushName || "User"
      const isGroup = from.endsWith("@g.us")

      let db = loadDB(config.dbFile)

      // Auto delete logic (Move to TOP to catch ALL messages if enabled)
      if (isGroup && db.groups[from]?.autodelete) {
        setTimeout(async () => {
          try {
            await sock.sendMessage(from, { delete: m.key })
          } catch (e) {
            console.error("Auto delete error:", e)
          }
        }, 5000)
      }

      if (m.key.fromMe) return

      const rawText = parseMessageText(m.message)
      const text = cleanText(rawText)

      const owner = isOwner(
        senderJid,
        senderNumber,
        config.ownerNumbers,
        config.ownerJids
      )

        // Command Detection Early
        let prefix = ""
        const prefixes = db.settings.multiPrefix ? db.settings.prefixes : [config.prefix]
        for (let p of prefixes) {
          if (text.startsWith(p)) {
            prefix = p
            break
          }
        }

        const isUserCmd = /^(fitur|menu|produk|pay|payment|pembayaran|list|ping|runtime|owner|me|profile|lb|leaderboard|order|myorder|cekorder|cancelorder|s|sticker|listinfo|info|penjelasan|welcome|goodbye|autodelete|antilink|antispam|lock)$/i.test(text.split(/\s+/)[0])
        
        if (!prefix && isUserCmd) {
          prefix = "" // No prefix for these user commands
        }

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

      // Auto-Responder Simple & Product Detail by Name
      if (!owner && !text.startsWith("#") && !prefix && !isUserCmd) {
        const lowerText = text.toLowerCase().trim()
        
        // Auto-reply cara order
        if (lowerText.includes("cara order") || lowerText.includes("beli gimana") || lowerText.includes("cara pesen")) {
          return reply(sock, from, "📦 *CARA ORDER:*\n1. Ketik `list` untuk cek produk\n2. Ketik `order ID,Qty,Alamat` untuk membeli\n3. Lakukan pembayaran via `pay`", m)
        }
        
        // Auto-reply ready/stok
        if (lowerText.includes("ready") || lowerText.includes("stok")) {
           return reply(sock, from, "🛒 Silahkan ketik `list` untuk cek stok produk yang tersedia saat ini kak!", m)
        }

        // Product Detail by Name lookup
        const foundProduct = db.list.find(p => p.nama.toLowerCase() === lowerText)
        if (foundProduct) {
          const statusEmoji = foundProduct.status === "Ready" ? "✅" : "⛔"
          const stockColor = foundProduct.stock > 10 ? "🟢" : foundProduct.stock > 0 ? "🟡" : "🔴"
          const promoTag = foundProduct.isPromo ? "🔥 *PROMO SEDANG BERLANGSUNG* 🔥\n" : ""

          return reply(
            sock,
            from,
            `
🔍 *DETAIL PRODUK*

${promoTag}
📦 Nama: ${foundProduct.nama}
🆔 ID: ${foundProduct.id}
💰 Harga: Rp ${Number(foundProduct.harga).toLocaleString("id-ID")}
🗂 Kategori: ${foundProduct.kategori}
📌 Status: ${foundProduct.status} ${statusEmoji}
📦 Stok: ${foundProduct.stock} ${stockColor}

📝 *Deskripsi*:
${foundProduct.deskripsi || "Tidak ada deskripsi."}

🛒 *Cara Order*:
Ketik: \`order ${foundProduct.id},1,-\`
`.trim(),
            m
          )
        }
      }

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
            if (!db.groups[from].warnings) db.groups[from].warnings = {}
            if (!db.groups[from].warnings[senderJid]) db.groups[from].warnings[senderJid] = 0
            
            db.groups[from].warnings[senderJid]++
            saveDB(config.dbFile, db)

            const strikes = db.groups[from].warnings[senderJid]
            const maxStrikes = 3

            if (strikes >= maxStrikes) {
              await reply(sock, from, `❌ Limit warning tercapai (${strikes}/${maxStrikes}). Kamu akan dikeluarkan dalam 5 detik!`, m)
              await sock.sendMessage(from, { delete: m.key })
              
              setTimeout(async () => {
                await safeKick(sock, from, senderJid)
                db.groups[from].warnings[senderJid] = 0
                saveDB(config.dbFile, db)
              }, 5000)
            } else {
              await reply(sock, from, `⚠️ *PERINGATAN* (@${senderNumber})\n\nLink dilarang di grup ini!\nStrike: ${strikes}/${maxStrikes}\nKirim link lagi = KICK.`, m, { mentions: [senderJid] })
              await sock.sendMessage(from, { delete: m.key })
            }
            return
          }
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
                if (!db.groups[from].warnings) db.groups[from].warnings = {}
                if (!db.groups[from].warnings[senderJid]) db.groups[from].warnings[senderJid] = 0
                
                db.groups[from].warnings[senderJid]++
                saveDB(config.dbFile, db)

                const strikes = db.groups[from].warnings[senderJid]
                const maxStrikes = 3

                if (strikes >= maxStrikes) {
                   await reply(sock, from, `❌ Spam berlebihan (${strikes}/${maxStrikes}). Kamu akan dikeluarkan dalam 5 detik!`, m)
                   setTimeout(async () => {
                     await safeKick(sock, from, senderJid)
                     db.groups[from].warnings[senderJid] = 0
                     saveDB(config.dbFile, db)
                   }, 5000)
                 } else {
                  await reply(sock, from, `⚠️ *PERINGATAN* (@${senderNumber})\n\nJangan spam! Strike: ${strikes}/${maxStrikes}`, m, { mentions: [senderJid] })
                }
                userMsgCount.delete(key) // Reset spam count after warning
                return
              }
           }
        }
         }
 
        // Anti-link Global
        const isLinkGlobal = /chat\.whatsapp\.com\/|wa\.me\//i.test(text)
        if (db.settings.antiLinkGlobal && isLinkGlobal && !owner) {
          await reply(sock, from, "❌ Link terdeteksi (Global Antilink)!", m)
          await sock.sendMessage(from, { delete: m.key })
          return
        }

        if (!text) return

        if (!prefix && !isUserCmd) return

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
        // Command Alias
        const aliases = {
          "p": "ping",
          "s": "sticker",
          "m": "fitur",
          "menu": "fitur",
          "pay": "payment",
          "pembayaran": "payment",
          "u": "profile",
          "me": "profile",
          "lb": "leaderboard",
          "bc": "bcuser",
          "bcg": "bcgroup",
          "info": "penjelasan"
        }
        if (aliases[cmd]) cmd = aliases[cmd]

        const now = Date.now()
       if (cooldown.has(senderNumber)) {
         const diff = now - cooldown.get(senderNumber)
         if (diff < config.cooldownMs) return
       }
       cooldown.set(senderNumber, now)

       log("IS OWNER:", owner)

      if (cmd === "fitur") {
        return reply(sock, from, makeFitur(pushName), m)
      }

      if (cmd === "penjelasan") {
        const query = args[0]?.toLowerCase()
        if (!query) return reply(sock, from, "Gunakan: info <nama_produk atau ID>", m)

        let info = db.explanations[query]
        let productName = query

        // Jika tidak ketemu berdasarkan nama, coba cari berdasarkan ID
        if (!info) {
          const product = db.list.find(p => String(p.id) === query || p.nama.toLowerCase() === query)
          if (product) {
            info = db.explanations[product.nama.toLowerCase()]
            productName = product.nama
          }
        }

        if (!info) return reply(sock, from, `❌ Penjelasan untuk "${query}" tidak ditemukan.`, m)

        return reply(sock, from, `ℹ️ *INFO PRODUK: ${productName.toUpperCase()}*\n\n${info}`, m)
      }

      if (cmd === "setinfo") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const product = args[0]?.toLowerCase()
        const text = args.slice(1).join(" ")

        if (!product || !text) return reply(sock, from, "Gunakan: #setinfo <nama_produk> <teks penjelasan>", m)

        db.explanations[product] = text
        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Penjelasan untuk "${product}" berhasil disimpan!`, m)
      }

      if (cmd === "delinfo") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        const product = args[0]?.toLowerCase()

        if (!product) return reply(sock, from, "Gunakan: #delinfo <nama_produk>", m)

        if (!db.explanations[product]) return reply(sock, from, "❌ Produk tidak ditemukan di daftar info.", m)

        delete db.explanations[product]
        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Penjelasan untuk "${product}" berhasil dihapus!`, m)
      }

      if (cmd === "listinfo") {
        const list = Object.keys(db.explanations)
        if (list.length === 0) return reply(sock, from, "📭 Belum ada info produk yang tersedia.", m)

        let teks = "ℹ️ *LIST INFO PRODUK*\n\n"
        list.forEach((item, i) => {
          teks += `${i + 1}. ${item}\n`
        })
        teks += "\nKetik: `info <nama>` untuk detail."
        return reply(sock, from, teks, m)
      }

      if (cmd === "payment") {
        const payInfo = db.payment || {}
        if (!payInfo.text && !payInfo.image) {
          return reply(sock, from, "❌ Info pembayaran belum diatur oleh owner.", m)
        }

        if (payInfo.image) {
          return await sock.sendMessage(from, {
            image: Buffer.from(payInfo.image, "base64"),
            caption: payInfo.text || "Silahkan lakukan pembayaran"
          }, { quoted: m })
        } else {
          return reply(sock, from, payInfo.text, m)
        }
      }

      if (cmd === "setpay") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        
        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
        let imageBuffer = null
        
        if (m.message?.imageMessage) {
          imageBuffer = await downloadMedia(m)
        } else if (quoted?.imageMessage) {
          imageBuffer = await downloadMedia({ message: quoted })
        }

        const textOut = args.join(" ")
        if (!textOut && !imageBuffer) {
          return reply(sock, from, "Gunakan: #setpay <teks instruksi> (sambil kirim/reply gambar QRIS)", m)
        }

        if (!db.payment) db.payment = {}
        if (textOut) db.payment.text = textOut
        if (imageBuffer) db.payment.image = imageBuffer.toString("base64")
        
        saveDB(config.dbFile, db)
        return reply(sock, from, "✅ Info pembayaran berhasil diperbarui!", m)
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
        return reply(sock, from, "Gunakan:\n#settings antilinkglobal\n#settings multiprefix", m)
      }

      if (cmd === "backup") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        try {
          const buffer = fs.readFileSync(config.dbFile)
          await sock.sendMessage(from, {
            document: buffer,
            mimetype: "application/json",
            fileName: "db_backup.json"
          }, { quoted: m })
          return reply(sock, from, "✅ Database backup terkirim", m)
        } catch (e) {
          console.error("Backup error:", e)
          return reply(sock, from, "❌ Gagal melakukan backup database: " + e.message, m)
        }
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
      if (cmd === "pushcontact") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        // Format: #pushcontact delay|pesan {opsi1|opsi2}
        const rawText = args.join(" ")
        if (!rawText || !rawText.includes("|")) {
          return reply(sock, from, "❌ Format salah!\nGunakan: `#pushcontact delay|Pesan Anda` atau `#pushcontact 20|Halo {kak|bang|teman}!`", m)
        }

        const [delayRaw, ...messageParts] = rawText.split("|")
        const delaySeconds = Number(delayRaw.trim())
        const messageTemplate = messageParts.join("|").trim()

        if (isNaN(delaySeconds) || delaySeconds < 10) {
          return reply(sock, from, "❌ Delay minimal 10 detik agar aman dari ban!", m)
        }

        const groupMeta = await sock.groupMetadata(from)
        const participants = groupMeta.participants.map(p => p.id).filter(jid => jid !== sock.user.id && jid !== senderJid)

        await reply(sock, from, `🚀 *PUSH CONTACT DIMULAI*\n\n👥 Target: ${participants.length} member\n⏳ Jeda: ${delaySeconds} detik\n🛡️ Mode: Anti-Detection (Jitter + Spin-tax)`, m)

        // Helper Spin-tax {halo|hi|p}
        const parseSpintax = (text) => {
          return text.replace(/{([^{}]+)}/g, (match, options) => {
            const choices = options.split("|")
            return choices[Math.floor(Math.random() * choices.length)]
          })
        }

        let success = 0
        let fail = 0

        for (let jid of participants) {
          try {
            const finalMessage = parseSpintax(messageTemplate)
            await sock.sendMessage(jid, { text: finalMessage })
            success++
            
            // Anti-detection: Jitter (acak tambahan 2-5 detik)
            const jitter = Math.floor(Math.random() * 5000) + 2000
            await new Promise(res => setTimeout(res, (delaySeconds * 1000) + jitter))
          } catch (e) {
            console.error(`Gagal push ke ${jid}:`, e)
            fail++
          }
        }

        return reply(sock, from, `✅ *PUSH CONTACT SELESAI*\n\n🚀 Berhasil: ${success}\n❌ Gagal: ${fail}`, m)
      }

      if (cmd === "bcuser" || cmd === "bcgrup" || cmd === "bcgroup" || cmd === "bcpromo") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)
        
        // Cek apakah ada parameter delay di awal (misal: -bcgroup 10 Teks Pesan)
        let delaySeconds = 8 // Default 8 detik
        let messageStartIndex = 0
        
        if (!isNaN(args[0]) && Number(args[0]) > 0) {
          delaySeconds = Number(args[0])
          messageStartIndex = 1
        }

        const textOut = args.slice(messageStartIndex).join(" ")
        if (!textOut) return reply(sock, from, `❌ Masukkan teks\n\nContoh dengan delay custom:\n#${cmd} 15 Halo semuanya\n(Artinya kirim tiap 15 detik)`, m)

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

        await reply(sock, from, `🚀 Mengirim broadcast ke ${targets.length} target dengan jeda ${delaySeconds} detik...`, m)

        for (let t of targets) {
          try {
            await sock.sendMessage(t, { text: header + textOut + footer })
            // Tambahkan sedikit variasi acak (+/- 1-2 detik) agar tidak terlalu robotik
            const jitter = Math.floor(Math.random() * 3000) 
            await new Promise(res => setTimeout(res, (delaySeconds * 1000) + jitter))
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
          return reply(sock, from, `🛒 *DAFTAR PRODUK*\n\n${textOut}\n\n_Order: order ID,Qty,Alamat_`, m)
        }

        if (sub === "search") {
          const query = args.slice(1).join(" ").trim().toLowerCase()
          if (!query) return reply(sock, from, "❌ Contoh: list search Netflix", m)

          const hasil = db.list.filter(item =>
            item.nama.toLowerCase().includes(query) ||
            item.kategori.toLowerCase().includes(query)
          )

          if (!hasil.length) return reply(sock, from, `❌ Produk "${query}" tidak ditemukan`, m)

          const textOut = hasil.map(item =>
            `• [${item.id}] ${item.nama} - Rp ${item.harga.toLocaleString("id-ID")}`
          ).join("\n")

          return reply(sock, from, `🔍 HASIL PENCARIAN: "${query.toUpperCase()}"\n\n${textOut}`, m)
        }

        if (sub === "kategori") {
          const kategori = args.slice(1).join(" ").trim().toLowerCase()
          if (!kategori) return reply(sock, from, "❌ Contoh: list kategori AI", m)

          const hasil = db.list.filter(item =>
            String(item.kategori).toLowerCase() === kategori
          )

          if (!hasil.length) return reply(sock, from, "❌ Produk kategori itu tidak ditemukan", m)

          const textOut = hasil.map(item =>
            `• [${item.id}] ${item.nama} - Rp ${item.harga.toLocaleString("id-ID")}`
          ).join("\n")

          return reply(sock, from, `📂 KATEGORI ${kategori.toUpperCase()}\n\n${textOut}`, m)
        }

        if (sub === "info" || sub === "detail") {
          const id = Number(args[1])
          if (Number.isNaN(id)) return reply(sock, from, "❌ Format: list info ID", m)

          const item = db.list.find(x => Number(x.id) === id)
          if (!item) return reply(sock, from, "❌ Produk tidak ditemukan", m)

          const statusEmoji = item.status === "Ready" ? "✅" : "⛔"
          const stockColor = item.stock > 10 ? "🟢" : item.stock > 0 ? "🟡" : "🔴"
          const promoTag = item.isPromo ? "🔥 *PROMO SEDANG BERLANGSUNG* 🔥\n" : ""

          return reply(
            sock,
            from,
            `
🔍 *DETAIL PRODUK*

${promoTag}
📦 Nama: ${item.nama}
🆔 ID: ${item.id}
💰 Harga: Rp ${Number(item.harga).toLocaleString("id-ID")}
🗂 Kategori: ${item.kategori}
📌 Status: ${item.status} ${statusEmoji}
📦 Stok: ${item.stock} ${stockColor}

📝 *Deskripsi*:
${item.deskripsi || "Tidak ada deskripsi."}

🛒 *Cara Order*:
Ketik: \`order ${item.id},1,-\`
`.trim(),
            m
          )
        }

        if (sub === "add") {

          const raw = args.slice(1).join(" ")
          const data = raw.split("|")

          if (data.length < 5) {
            return reply(sock, from, "❌ Format: #list add Nama|Harga|Kategori|Status|Stock|Deskripsi(opsional)", m)
          }

          const [nama, hargaRaw, kategori, status, stockRaw, deskripsi] = data.map(x => x?.trim())
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
            stock,
            deskripsi: deskripsi || "",
            isPromo: false
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
📦 Stok: ${stock}
📝 Deskripsi: ${deskripsi || "-"}`,
            m
          )
        }

        if (sub === "edit") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const id = Number(args[1])
          const raw = args.slice(2).join(" ")
          const [key, value] = raw.split("=").map(x => x.trim())

          if (Number.isNaN(id) || !key || !value) {
            return reply(sock, from, "❌ Format: #list edit ID key=value\nContoh: #list edit 1 stock=10", m)
          }

          const index = db.list.findIndex(item => Number(item.id) === id)
          if (index === -1) return reply(sock, from, "❌ Produk tidak ditemukan", m)

          const validKeys = ["nama", "harga", "kategori", "status", "stock", "deskripsi", "ispromo"]
          if (!validKeys.includes(key.toLowerCase())) {
            return reply(sock, from, `❌ Key tidak valid. Gunakan: ${validKeys.join(", ")}`, m)
          }

          let finalValue = value
          if (key.toLowerCase() === "harga" || key.toLowerCase() === "stock") finalValue = Number(value)
          if (key.toLowerCase() === "ispromo") finalValue = (value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "on")

          if ((key.toLowerCase() === "harga" || key.toLowerCase() === "stock") && Number.isNaN(finalValue)) {
            return reply(sock, from, `❌ ${key} harus angka`, m)
          }

          db.list[index][key.toLowerCase() === "ispromo" ? "isPromo" : key.toLowerCase()] = finalValue
          saveDB(config.dbFile, db)

          return reply(sock, from, `✅ Produk ${id} diperbarui: ${key} = ${finalValue}`, m)
        }

        if (sub === "remove") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const id = Number(args[1])

          if (Number.isNaN(id)) {
            return reply(sock, from, "❌ Format: #list remove ID", m)
          }

          const before = db.list.length
          db.list = db.list.filter(item => Number(item.id) !== id)

          if (db.list.length === before) {
            return reply(sock, from, "❌ Produk tidak ditemukan", m)
          }

          saveDB(config.dbFile, db)
          return reply(sock, from, `🗑 Produk dengan ID ${id} dihapus`, m)
        }

        if (!sub) {
          if (!db.list.length) return reply(sock, from, "📭 *List produk kosong*", m)
          
          let simpleList = "🛒 *DAFTAR PRODUK SINGKAT*\n\n"
          db.list.forEach(item => {
            simpleList += `• [${item.id}] ${item.nama}\n`
          })
          simpleList += "\n_Ketik `list info <id>` untuk detail_"
           
           if (owner) {
             simpleList += "\n\n👮‍♂️ *ADMIN MENU:* \n#list add, #list edit, #list remove"
           }
          
          return reply(sock, from, simpleList, m)
        }

        return reply(
          sock,
          from,
          `
🛒 *MENU LIST PRODUK*

• list show (Lihat semua)
• list search <nama>
• list kategori <nama>
• list info <id> (Detail produk)

👮‍♂️ *ADMIN LIST*
• #list add Nama|Harga|Kategori|Status|Stock|Deskripsi
• #list edit ID key=value (nama, harga, kategori, status, stock, deskripsi, ispromo)
• #list remove ID
`.trim(),
          m
        )
      }

      if (cmd === "order") {
        const raw = args.join(" ")
        const data = raw.split(",")

        if (data.length < 3) {
          return reply(
            sock,
            from,
            "❌ Format: order idproduk,qty,alamat\nContoh: order 2,1,-",
            m
          )
        }

        const [produkIdRaw, qtyRaw, alamat] = data.map(x => x.trim())
        const produkId = Number(produkIdRaw)
        const qty = Number(qtyRaw)

        if (Number.isNaN(produkId) || Number.isNaN(qty)) {
          return reply(sock, from, "❌ ID produk dan qty harus angka", m)
        }

        const productIndex = db.list.findIndex(item => Number(item.id) === produkId)
        if (productIndex === -1) {
          return reply(sock, from, "❌ Produk tidak ditemukan. Ketik list show", m)
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
          nama: pushName,
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

Ketik *cekorder ${id}* untuk melihat status.
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
        
        if (!id || !note) return reply(sock, from, "❌ Format: #addnote ID Catatan", m)
        
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
          } else if (m.message?.imageMessage || m.message?.videoMessage) {
            msg = m
          }

          if (!msg) {
            return reply(sock, from, "❌ Kirim/reply gambar atau video untuk jadi sticker", m)
          }

          let buffer = await downloadMedia(msg)
          
          // Parse metadata: -s packname|author atau -s "teks stiker"
          let input = args.join(" ").trim()
          let [packname, author] = input.split("|")
          
          // Check for text overlay in quotes: -s "halo" or just text if no quotes
          // If no | separator, assume the whole thing might be text if it's in quotes
          let stickerText = null
          const textMatch = input.match(/"([^"]+)"/)
          if (textMatch) {
            stickerText = textMatch[1]
            // If text was in quotes, packname/author should be default
            packname = config.botName
            author = "Owner"
          } else if (input && !input.includes("|")) {
             // If no quotes and no separator, treat as possible text
             stickerText = input
          }

          if (stickerText && (msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage)) {
            try {
              // Gunakan ImageScript untuk manipulasi gambar & teks (lebih cepat & RAM friendly)
              const img = await ImageScript.Image.decode(buffer)
              img.contain(512, 512)
              
              // Tambahkan teks jika ada
              try {
                // Gunakan font default jika Font.load gagal
                // Mencari font di folder node_modules
                const fontPath = path.join(__dirname, "node_modules/imagescript/src/fonts/inter/Inter-Bold.ttf")
                if (fs.existsSync(fontPath)) {
                  const font = await ImageScript.Font.load(fs.readFileSync(fontPath))
                  
                  // Render teks shadow (hitam)
                  const shadow = await ImageScript.Image.renderText(font, 64, stickerText, 0x000000ff)
                  img.composite(shadow, (img.width / 2) - (shadow.width / 2) + 2, img.height - shadow.height - 38)
                  
                  // Render teks utama (putih)
                  const text = await ImageScript.Image.renderText(font, 64, stickerText, 0xffffffff)
                  img.composite(text, (img.width / 2) - (text.width / 2), img.height - text.height - 40)
                }
              } catch (fontErr) {
                console.error("Font rendering failed, sending sticker without text:", fontErr)
              }
              
              buffer = Buffer.from(await img.encode(3)) // 3 = PNG, convert to Buffer for wa-sticker-formatter
            } catch (e) {
              console.error("Image processing error (ImageScript):", e)
              // Fallback ke Jimp v1 (hanya resize) jika ImageScript gagal total
              try {
                const image = await Jimp.read(buffer)
                image.contain({ w: 512, h: 512 })
                buffer = await image.getBuffer("image/png")
              } catch (jimpErr) {
                console.error("Jimp fallback failed:", jimpErr)
              }
            }
          }
          
          packname = packname?.trim() || config.botName
          author = author?.trim() || "Owner"

          await sendSticker(sock, from, buffer, m, packname, author)

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
            "❌ Format:\n#spam teks jumlah delay(ms)\natau\n#spam 628xxxx teks jumlah delay",
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
        if (!textCustom) return reply(sock, from, "❌ Masukkan teks promosi\nContoh: #hta Promo Netflix Murah!", m)

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
• *Tambah*: \`#list add Netflix|35000|Streaming|Ready|50\`
• *Edit*: \`#list edit 1 stock=100\`

2️⃣ *MANAJEMEN ORDER*
• *Proses*: \`#process ORD-123\`
• *Selesai*: \`#done ORD-123\`
• *Catatan*: \`#addnote ORD-123 Akun: abc@mail.com | Pass: 123\`
• *Refund*: \`#refund ORD-123\` (Stok balik otomatis)

3️⃣ *AUTO STATUS & MESSAGE*
• *Status Grup (Story)*: \`#setgroupstatus Teks|Menit\`
  └ _Member grup akan lihat bot punya SW baru._
• *Pesan Grup (Chat)*: \`#setautomsg Teks|Menit\`
  └ _Bot kirim chat otomatis ke dalam grup._
• *Status Global (Story)*: \`#setautostatus Teks|Menit\`
  └ _Semua kontak akan lihat SW bot._

4️⃣ *PROMOSI & KEAMANAN*
• *Hide Tag*: \`#hta Promo!\` (Tag semua tanpa list)
• *Mute*: \`#mute @tag\` (Hapus pesan dia otomatis)
• *Anti-Link*: \`#antilink on\` (Auto kick pengirim link)

5️⃣ *SISTEM*
• *Stats*: \`#stats\` (Monitor RAM VPS 1GB)
• *Backup*: \`#backup\` (Bot kirim file db.json)
• *Clear Cache*: \`#clearcache\` (Manual bersihkan RAM)
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
          return reply(sock, from, `❌ Format: #${cmd} Teks|IntervalMenit\nContoh: #${cmd} Promo Netflix Murah|60`, m)
        }

        if (!db.groups[from]) db.groups[from] = {}
        db.groups[from].autoMsg = {
          enabled: db.groups[from].autoMsg?.enabled || false,
          text: textMsg,
          interval: interval,
          lastSent: 0
        }
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Auto Message berhasil diatur!\n\n📝 Teks: ${textMsg}\n⏱ Interval: ${interval} menit\n📌 Status: ${db.groups[from].autoMsg.enabled ? "ON" : "OFF"}\n\nKetik *#automsg on* untuk mengaktifkan.`, m)
      }

      if (cmd === "automsg") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, "Gunakan: #automsg on/off", m)

        if (!db.groups[from]?.autoMsg?.text) {
          return reply(sock, from, "❌ Atur teks dulu dengan: #setautomsg Teks|Menit", m)
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

      // Auto Status (Story) Commands
      if (cmd === "setautostatus" || cmd === "editautostatus") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const raw = args.join(" ")
        const [textStatus, intervalRaw] = raw.split("|").map(x => x.trim())
        const interval = Number(intervalRaw)

        if (!textStatus || isNaN(interval) || interval < 1) {
          return reply(sock, from, `❌ Format: #${cmd} Teks|IntervalMenit\nContoh: #${cmd} Promo Netflix Story|120`, m)
        }

        if (!db.settings) db.settings = {}
        db.settings.autoStatus = {
          enabled: db.settings.autoStatus?.enabled || false,
          text: textStatus,
          interval: interval,
          lastSent: 0
        }
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Auto Status (Story) berhasil diatur!\n\n📝 Teks: ${textStatus}\n⏱ Interval: ${interval} menit\n📌 Status: ${db.settings.autoStatus.enabled ? "ON" : "OFF"}\n\nKetik *#autostatus on* untuk mengaktifkan ke Story WA kamu.`, m)
      }

      if (cmd === "autostatus") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, "Gunakan: #autostatus on/off", m)

        if (!db.settings?.autoStatus?.text) {
          return reply(sock, from, "❌ Atur teks dulu dengan: #setautostatus Teks|Menit", m)
        }

        db.settings.autoStatus.enabled = (sub === "on")
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Auto Status (Story) diubah ke ${sub.toUpperCase()}`, m)
      }

      if (cmd === "removeautostatus") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        if (!db.settings?.autoStatus) return reply(sock, from, "❌ Tidak ada setting Auto Status", m)

        delete db.settings.autoStatus
        saveDB(config.dbFile, db)

        return reply(sock, from, "✅ Setting Auto Status (Story) berhasil dihapus", m)
      }

      // Group Status (Per-Group Story) Commands
      if (cmd === "setgroupstatus" || cmd === "editgroupstatus") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const raw = args.join(" ")
        const [textStatus, intervalRaw] = raw.split("|").map(x => x.trim())
        const interval = Number(intervalRaw)

        if (!textStatus || isNaN(interval) || interval < 1) {
          return reply(sock, from, `❌ Format: -${cmd} Teks|IntervalMenit\nContoh: -${cmd} Promo Netflix Group|120`, m)
        }

        if (!db.groups[from]) db.groups[from] = {}
        db.groups[from].groupStatus = {
          enabled: db.groups[from].groupStatus?.enabled || false,
          text: textStatus,
          interval: interval,
          lastSent: 0
        }
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Status Grup (Story) berhasil diatur!\n\n📝 Teks: ${textStatus}\n⏱ Interval: ${interval} menit\n📌 Status: ${db.groups[from].groupStatus.enabled ? "ON" : "OFF"}\n\nKetik *-groupstatus on* untuk mengaktifkan.`, m)
      }

      if (cmd === "groupstatus") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, "Gunakan: -groupstatus on/off", m)

        if (!db.groups[from]?.groupStatus?.text) {
          return reply(sock, from, "❌ Atur teks dulu dengan: -setgroupstatus Teks|Menit", m)
        }

        db.groups[from].groupStatus.enabled = (sub === "on")
        saveDB(config.dbFile, db)

        return reply(sock, from, `✅ Status Grup (Story) diubah ke ${sub.toUpperCase()}`, m)
      }

      if (cmd === "removegroupstatus") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        if (!db.groups[from]?.groupStatus) return reply(sock, from, "❌ Tidak ada setting Status Grup", m)

        delete db.groups[from].groupStatus
        saveDB(config.dbFile, db)

        return reply(sock, from, "✅ Setting Status Grup berhasil dihapus", m)
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
          await safeKick(sock, from, p.id)
        }
        return reply(sock, from, "✅ Selesai", m)
      }

      // Security Grup Commands
      if (["antilink", "welcome", "goodbye", "autodelete", "antispam"].includes(cmd)) {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)
        const groupMeta = await sock.groupMetadata(from)
        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )
        if (!isAdmin && !owner) return reply(sock, from, "❌ Khusus admin", m)

        const sub = (args[0] || "").toLowerCase()
        if (sub !== "on" && sub !== "off") return reply(sock, from, `Gunakan: #${cmd} on/off`, m)

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
         if (!textOut) return reply(sock, from, `Gunakan: #${cmd} teks`, m)

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
          return reply(sock, from, "Gunakan: #lock on/off", m)
        }
      }

      return reply(sock, from, "❓ Command tidak dikenal. Ketik `fitur` untuk melihat menu.", m)
    } catch (err) {
      console.error("ERROR messages.upsert:", err)
    }
  })
}

startBot().catch(console.error)
const path = require("path")

module.exports = {
  prefix: "-",
  debug: true,
  botName: "Digimu Bot",

  ownerNumbers: [
    "6285138745718"
  ],

  ownerJids: [
    "6285138745718@s.whatsapp.net",
    "6285138745718@lid",
    "13001486762213@lid"
  ],

  sessionPath: path.join(__dirname, "session"),
  dbFile: path.join(__dirname, "db.json"),

  cooldownMs: 2500,
  cooldownSweepMs: 60 * 1000,

  timezone: "Asia/Jakarta"
}